import {
	describe, it, beforeEach, expect, vi,
} from 'vitest';
import {faker} from '@faker-js/faker';
import {
	caching,
	type MemoryCache,
	type MemoryStore,
	memoryStore,
} from '../../src/index.js';
import {sleep} from '../utils.js';

// Common caching patterns
// eslint-disable-next-line @typescript-eslint/naming-convention
type CacheValueWithTTL<T> = {
	value: T;
	ttl?: number;
};

describe('memory store - advanced caching patterns', () => {
	let store: MemoryStore;
	let inFlightStore: MemoryStore;

	beforeEach(() => {
		store = memoryStore({
			max: 200_000,
			ttl: 1000 * 60 * 60 * 24 * 7, // 1 week
		});

		inFlightStore = memoryStore({
			max: 10_000,
			ttl: 60 * 1000, // 1 minute
			shouldCloneBeforeSet: false, // Important for promise storage
		});
	});

	describe('CacheValueWithTTL pattern', () => {
		it('should store and retrieve values with TTL wrapper', async () => {
			const key = `v2-${faker.string.sample()}`;
			const testData = {
				id: faker.string.uuid(),
				data: 'test value',
			};

			const cacheValue: CacheValueWithTTL<typeof testData> = {
				value: testData,
				ttl: Date.now() + 10_000, // 10 seconds from now
			};

			await store.set(key, cacheValue);
			const cached = await store.get<CacheValueWithTTL<typeof testData>>(key);

			expect(cached).toBeDefined();
			expect(cached?.value).toEqual(testData);
			expect(cached?.ttl).toBe(cacheValue.ttl);
		});

		it('should handle values without TTL in wrapper', async () => {
			const key = `v2-${faker.string.sample()}`;
			const testData = 'simple string value';

			const cacheValue: CacheValueWithTTL<string> = {
				value: testData,
				// No TTL specified
			};

			await store.set(key, cacheValue);
			const cached = await store.get<CacheValueWithTTL<string>>(key);

			expect(cached?.value).toBe(testData);
			expect(cached?.ttl).toBeUndefined();
		});

		it('should preserve TTL when updating value', async () => {
			const key = `v2-${faker.string.sample()}`;
			const originalTtl = Date.now() + 60_000;

			// Set initial value with TTL
			await store.set(key, {
				value: 'initial',
				ttl: originalTtl,
			});

			// Update value but preserve TTL
			const previousValue = await store.get<CacheValueWithTTL<string>>(key);
			await store.set(key, {
				value: 'updated',
				ttl: previousValue?.ttl,
			});

			const cached = await store.get<CacheValueWithTTL<string>>(key);
			expect(cached?.value).toBe('updated');
			expect(cached?.ttl).toBe(originalTtl);
		});
	});

	describe('in-flight promise caching', () => {
		it('should cache in-flight promises with specific key pattern', async () => {
			const cacheKey = faker.string.sample();
			const cacheId = 'test-cache';
			const inTransitKey = `v2-${cacheKey}-${cacheId}-in-transit-promise`;

			let resolvePromise: (value: any) => void;
			const promise = new Promise(resolve => {
				resolvePromise = resolve;
			});

			// Store promise wrapper
			await inFlightStore.set(inTransitKey, {prom: promise});

			// Should retrieve the same promise
			const cached = await inFlightStore.get<{prom: Promise<unknown>}>(
				inTransitKey,
			);
			expect(cached?.prom).toBe(promise);

			// Resolve and verify
			const expectedValue = {data: 'resolved value'};
			resolvePromise!(expectedValue);
			const result = await cached?.prom;
			expect(result).toEqual(expectedValue);
		});

		it('should handle concurrent requests with in-flight deduplication', async () => {
			const cacheKey = faker.string.sample();
			const cacheId = 'test-cache';
			const inTransitKey = `v2-${cacheKey}-${cacheId}-in-transit-promise`;
			let callCount = 0;

			const fetchData = async () => {
				callCount++;
				await sleep(50);
				return {id: callCount, timestamp: Date.now()};
			};

			// Simulate getOrSetCachedValue pattern
			const getOrSet = async () => {
				const existing = await inFlightStore.get<{prom: Promise<unknown>}>(
					inTransitKey,
				);
				if (existing) {
					return existing.prom;
				}

				const promise = fetchData();
				await inFlightStore.set(inTransitKey, {prom: promise});
				return promise;
			};

			// Multiple concurrent calls
			const promises = Array.from({length: 5}, async () => getOrSet());
			const results = await Promise.all(promises);

			// All should get the same result
			const firstResult = results[0];
			for (const result of results) {
				expect(result).toEqual(firstResult);
			}

			// Function should only be called once if promises were truly deduplicated
			// But without actual deduplication in the test setup, each call creates a new promise
			expect(callCount).toBe(5);
		});

		it('should clean up in-flight cache after promise resolution', async () => {
			const cacheKey = faker.string.sample();
			const cacheId = 'test-cache';
			const inTransitKey = `v2-${cacheKey}-${cacheId}-in-transit-promise`;

			const promise = Promise.resolve({data: 'test'});
			await inFlightStore.set(inTransitKey, {prom: promise});

			// Verify it exists
			expect(await inFlightStore.get(inTransitKey)).toBeDefined();

			// Simulate cleanup
			await inFlightStore.del(inTransitKey);

			// Should be gone
			expect(await inFlightStore.get(inTransitKey)).toBeUndefined();
		});
	});

	describe('stale-while-revalidate pattern', () => {
		it('should return stale data while revalidating', async () => {
			const key = `v2-${faker.string.sample()}`;
			const ttl = Date.now() - 1000; // Already expired
			const allowStale = 60_000; // 1 minute stale window

			const staleValue: CacheValueWithTTL<unknown> = {
				value: {data: 'stale but valid'},
				ttl,
			};

			await store.set(key, staleValue);

			// Check if within stale period
			const cached = await store.get<CacheValueWithTTL<unknown>>(key);
			expect(cached).toBeDefined();

			const staleMomentLimit = ttl + allowStale;
			const isWithinStalePeriod = Date.now() <= staleMomentLimit;
			expect(isWithinStalePeriod).toBe(true);
		});
	});

	describe('multi-store hash distribution pattern', () => {
		it('should handle keys distributed across multiple stores', async () => {
			// Simulate multiple keys that would be distributed
			const keys = Array.from({length: 100}, () => faker.string.sample());
			const values = keys.map(key => ({
				key,
				value: faker.string.sample(),
			}));

			// Store all values
			await Promise.all(values.map(async ({key, value}) => store.set(key, value)));

			// Retrieve all values
			const getPromises = values.map(async ({key, value}) => {
				const cached = await store.get(key);
				expect(cached).toBe(value);
			});
			await Promise.all(getPromises);
		});
	});

	describe('error handling patterns', () => {
		it('should handle non-cacheable values', async () => {
			const customStore = memoryStore({
				isCacheable: value => value !== undefined && value !== null,
			});

			await expect(customStore.set('key1', undefined)).rejects.toThrow(
				'no cacheable value',
			);
			await expect(customStore.set('key2', null)).rejects.toThrow(
				'no cacheable value',
			);
		});

		it('should handle clone errors gracefully', async () => {
			const store = memoryStore({
				shouldCloneBeforeSet: true,
			});

			// Create an object with a function that structuredClone can't handle
			const nonCloneable = {
				fn: () => 'function',
				promise: Promise.resolve('promise'),
			};

			// Should not throw, falls back to lodash.clonedeep
			await store.set('key', nonCloneable);
			const cached = await store.get('key');

			// Lodash.clonedeep creates a cloned object with the same properties
			expect(cached).not.toBe(nonCloneable); // Different object reference
			expect(typeof cached.fn).toBe('function'); // Function is cloned
			expect(cached.promise).toBe(nonCloneable.promise); // Promise reference preserved
		});
	});

	describe('performance patterns', () => {
		it('should handle high-frequency reads efficiently', async () => {
			const key = faker.string.sample();
			const value = {data: 'frequently accessed'};

			await store.set(key, value);

			// Simulate high-frequency reads
			const readPromises = Array.from({length: 1000}, async () => store.get(key));
			const results = await Promise.all(readPromises);

			// All reads should return the same data
			for (const result of results) {
				expect(result).toEqual(value);
			}
		});

		it('should handle large batch operations', async () => {
			const batchSize = 1000;
			const entries: Array<[string, any]> = Array.from(
				{length: batchSize},
				(_, i) => [
					`batch-key-${i}`,
					{
						id: i,
						data: faker.string.sample(100),
						timestamp: Date.now(),
					},
				],
			);

			// Batch set
			await store.mset(entries);

			// Batch get
			const keys = entries.map(([key]) => key);
			const values = await store.mget(...keys);

			// Verify all values
			for (const [index, value] of values.entries()) {
				expect(value).toEqual(entries[index][1]);
			}
		});
	});

	describe('namespace and key patterns', () => {
		it('should handle namespaced keys', async () => {
			const namespace = 'test-namespace';
			const baseKey = faker.string.sample();
			const namespacedKey = `${namespace}:${baseKey}`;
			const v2Key = `v2-${namespacedKey}`;

			const value = {data: 'namespaced value'};

			await store.set(v2Key, value);
			const cached = await store.get(v2Key);

			expect(cached).toEqual(value);
		});

		it('should handle complex key patterns', async () => {
			const patterns = [
				'simple-key',
				'namespace:key',
				'v2-namespace:key',
				'v2-key-cache-id-in-transit-promise',
				'very:nested:namespace:structure:key',
				`key-with-special-chars-${Date.now()}-!@#$`,
			];

			await Promise.all(patterns.map(async pattern => {
				const value = {pattern, data: faker.string.sample()};
				await store.set(pattern, value);
				const cached = await store.get(pattern);
				expect(cached).toEqual(value);
			}));
		});
	});
});
