/**
 * Envio 3.15 codegen writes a file-local `type EvmBlock = {...}` into
 * `.envio/types.d.ts` and references it bare inside the file's own
 * `declare module "envio"` block. Envio 3.15 also exports a generic
 * `EvmBlock<Fields>`, and inside the module block the bare name binds to that
 * export: TS2314, which `skipLibCheck` hides, so `event.block` degrades to
 * `any` in every handler. Renaming the local alias restores the generated
 * block type. Upstream: enviodev/hyperindex#1808 (fix in #1809, which picks
 * the same name). Once codegen stops emitting the colliding alias this is a
 * no-op; delete it then.
 */
export const renameCollidingEvmBlockAlias = (content) => {
  if (!/^type EvmBlock = \{/m.test(content)) {
    return content;
  }
  return content.replace(/\bEvmBlock\b(?!<)/g, "EvmBlockShape");
};
