/**
 * Casts a value to a Readonly version of its type.
 * Useful for ensuring immutability at the type level.
 *
 * @param value - The value to cast.
 * @returns The same value, typed as Readonly.
 */
export const readonly = <T>(value: T): Readonly<T> => value;

/**
 * Creates a memoized version of a getter function.
 *
 * @param getter - A function that returns a value to be memoized.
 * @returns A function that, when called, returns the cached value from the getter.
 */
export const voidMemo = <T>(getter: () => T) => {
  let cache: null | T = null;

  return () => {
    cache ??= getter();

    return cache;
  };
};
