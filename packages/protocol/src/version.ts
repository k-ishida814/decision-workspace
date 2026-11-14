/** Set by the release build (scripts/build.ts); "dev" when run from source. */
declare const DW_VERSION: string | undefined;
export const VERSION: string = typeof DW_VERSION === "string" ? DW_VERSION : "dev";
