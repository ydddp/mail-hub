/// <reference lib="dom" />

/**
 * Origin of the Mail Hub that served this script, or the unreplaced mark
 * `%%MAILHUB_ORIGIN%%` when the file was installed some other way.
 */
declare const __MAILHUB_SERVED_FROM__: string;

declare module '*.css' {
  const content: string;
  export default content;
}
