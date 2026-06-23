/**
 * Resource lifecycle ordering.
 *
 * Generated suites previously ran in arbitrary order, so a DELETE could execute before the
 * GET that depended on the resource, and creates/deletes polluted shared state with no
 * sequencing. This assigns each test a lifecycle `order` and marks setup/teardown so a
 * resource is created first, read/updated in the middle, and deleted last — within each
 * resource group the renderers emit tests in this order.
 *
 * Ordering is intentionally coarse and deterministic (create < mutate/read < delete) rather
 * than a full dependency graph: it removes the most common order-dependence and cleanup
 * gaps without fragile cross-resource inference.
 */
import type { GeneratedTestCase } from '@shared/types';

const ORDER_CREATE = 10;
const ORDER_DEFAULT = 50;
const ORDER_TEARDOWN = 90;

// True when the path targets a specific resource instance (an id/param segment anywhere),
// e.g. `/users/{id}` or `/users/{id}/sessions` — both are item-level deletes that should run
// as teardown, not just a trailing `/{id}`.
const pathHasIdSegment = (path: string): boolean => /\/(:\w+|\{[^}]+\})(\/|$)/.test(path);

/**
 * Annotate each test with a lifecycle `order` (and `isSetup`/`isTeardown`) and return the
 * list sorted. Only success-oriented (positive) creates/deletes participate in sequencing;
 * negative and security tests deliberately provoke failures and stay in the middle band so
 * they never run as setup or teardown.
 */
export const orderTestsByLifecycle = (tests: GeneratedTestCase[]): GeneratedTestCase[] => {
  const annotated = tests.map((test, index) => {
    const method = test.request.method.toUpperCase();
    const isPositive = test.category === 'positive';
    let order = ORDER_DEFAULT;
    let isSetup = false;
    let isTeardown = false;

    if (isPositive && method === 'POST') {
      order = ORDER_CREATE;
      isSetup = true;
    } else if (isPositive && method === 'DELETE' && pathHasIdSegment(test.request.path)) {
      order = ORDER_TEARDOWN;
      isTeardown = true;
    }

    return {
      test: {
        ...test,
        order,
        ...(isSetup ? { isSetup: true } : {}),
        ...(isTeardown ? { isTeardown: true } : {})
      },
      index
    };
  });

  // Stable sort: order ascending, original order preserved within the same band.
  annotated.sort((a, b) => {
    const byOrder = (a.test.order ?? ORDER_DEFAULT) - (b.test.order ?? ORDER_DEFAULT);
    return byOrder !== 0 ? byOrder : a.index - b.index;
  });

  return annotated.map((entry) => entry.test);
};
