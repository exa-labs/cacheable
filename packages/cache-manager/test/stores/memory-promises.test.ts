import { describe, it, beforeEach, expect, vi } from "vitest";
import { faker } from "@faker-js/faker";
import {
  caching,
  type MemoryCache,
  type MemoryStore,
  memoryStore,
} from "../../src/index.js";
import { sleep } from "../utils.js";

describe("memory store - promise and complex type handling", () => {
  let cache: MemoryCache;
  let store: MemoryStore;

  beforeEach(async () => {
    store = memoryStore({ max: 100 });
    cache = await caching("memory", {
      max: 100,
      shouldCloneBeforeSet: true,
    });
  });

  describe("promise caching", () => {
    it("should cache resolved promises as values", async () => {
      const key = faker.string.sample();
      const expectedValue = { data: "test data" };
      const promise = Promise.resolve(expectedValue);

      // Wait for promise to resolve
      const resolvedValue = await promise;
      await store.set(key, resolvedValue);

      const cached = await store.get(key);
      expect(cached).toEqual(expectedValue);
    });

    it("should cache promise results using wrap pattern", async () => {
      const key = faker.string.sample();
      let callCount = 0;

      const fetchData = async () => {
        callCount++;
        await sleep(10);
        return { id: callCount, data: "async result" };
      };

      // First call - cache miss
      const result1 = await cache.wrap(key, fetchData, 1000);
      expect(result1).toEqual({ id: 1, data: "async result" });
      expect(callCount).toBe(1);

      // Second call - cache hit
      const result2 = await cache.wrap(key, fetchData, 1000);
      expect(result2).toEqual({ id: 1, data: "async result" });
      expect(callCount).toBe(1);
    });

    it("should handle concurrent promise calls (in-flight deduplication)", async () => {
      const key = faker.string.sample();
      let callCount = 0;

      const fetchData = async () => {
        callCount++;
        await sleep(50);
        return { id: callCount, data: "async result" };
      };

      // Start multiple concurrent calls
      const promises = Array.from({ length: 5 }, async () =>
        cache.wrap(key, fetchData, 1000),
      );

      const results = await Promise.all(promises);

      // All results should be the same
      for (const result of results) {
        expect(result).toEqual({ id: 1, data: "async result" });
      }

      // Function should only be called once
      expect(callCount).toBe(1);
    });
  });

  describe("vulcan cache patterns", () => {
    it("should cache CacheValueWithTTL objects", async () => {
      const key = faker.string.sample();
      const cacheValue = {
        value: {
          id: faker.string.uuid(),
          name: faker.person.fullName(),
          data: { nested: "value", count: 42 },
        },
        ttl: Date.now() + 60_000, // 1 minute from now
      };

      await store.set(key, cacheValue);
      const cached = await store.get(key);

      expect(cached).toBeDefined();
      expect(cached.value).toEqual(cacheValue.value);
      expect(cached.ttl).toBe(cacheValue.ttl);
      // Verify the object was cloned, not referenced
      expect(cached).not.toBe(cacheValue);
      expect(cached.value).not.toBe(cacheValue.value);
    });

    it("should handle CacheValueWithTTL without ttl field", async () => {
      const key = faker.string.sample();
      const cacheValue = {
        value: { data: "test data" },
        // No ttl field
      };

      await store.set(key, cacheValue);
      const cached = await store.get(key);

      expect(cached).toBeDefined();
      expect(cached.value).toEqual(cacheValue.value);
      expect(cached.ttl).toBeUndefined();
    });
  });

  describe("in-flight promise caching pattern", () => {
    it("should support in-flight promise caching", async () => {
      const inFlightCache = memoryStore({
        max: 100,
        ttl: 60 * 1000, // 1 minute
        shouldCloneBeforeSet: false, // Important for promise caching
      });

      const key = faker.string.sample();
      const expectedValue = { data: "resolved" };

      // Create a promise that resolves after a short delay
      const promise = new Promise((resolve) => {
        setTimeout(() => {
          resolve(expectedValue);
        }, 10);
      });

      // Store the promise wrapped in an object (like vulcan does)
      const wrappedPromise = { prom: promise };
      await inFlightCache.set(key, wrappedPromise);

      // Should get the same wrapped promise back
      const cached = await inFlightCache.get<{
        prom: Promise<typeof expectedValue>;
      }>(key);
      expect(cached).toBe(wrappedPromise);
      expect(cached?.prom).toBe(promise);

      // The cached promise should resolve to the same value
      const result = await cached?.prom;
      expect(result).toEqual(expectedValue);
    }, 10_000);

    it("should preserve promise references in nested objects with cloning", async () => {
      const key = faker.string.sample();
      const promise = Promise.resolve({ data: "resolved" });

      // Store promise wrapped in object (like vulcan does)
      const wrappedPromise = { prom: promise };
      await store.set(key, wrappedPromise);

      const cached = await store.get(key);
      // With shouldCloneBeforeSet=true (default), lodash.clonedeep is used as fallback
      // and it preserves promise references in nested objects
      expect(cached.prom).toBe(promise);
      expect(cached).not.toBe(wrappedPromise); // The wrapper is cloned
    });
  });
});
