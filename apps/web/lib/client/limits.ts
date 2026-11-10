/**
 * Mirror of API_LIMITS in packages/core/src/api-types.ts (the client avoids a runtime import of
 * core). test/ui/slug.test.ts asserts the two stay equal.
 */
export const API_LIMITS = {
  slugMaxLength: 64,
  titleOverrideMaxLength: 200,
  descriptionOverrideMaxLength: 500,
  linksPerNamespace: 200,
} as const;
