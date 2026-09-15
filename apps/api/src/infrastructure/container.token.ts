/**
 * Injection token for the composition root.
 *
 * Kept in its own module so controllers can import the token without importing
 * the container implementation, which would drag Redis and Postgres clients
 * into the presentation layer's module graph.
 */
export const CONTAINER = Symbol('RunnerApiContainer');
