import { describe, expect, test } from "bun:test";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND, applyNativeVisibility } from "../../src/codex/catalog/metadata";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import { NATIVE_RESERVE_MODEL } from "../../src/codex/catalog/native-models";
import { RESERVE_LUNA_METADATA_SOURCE, RESERVE_METADATA_SOURCE_FIELD } from "../../src/codex/catalog/reserve";
import { omitVisibilityHiddenRows } from "../../src/codex/catalog/build-entries";
import type { RawEntry } from "../../src/codex/catalog/parsing";

const nativeRow = (slug: string): RawEntry => ({ slug } as RawEntry);

/**
 * The codex-rs picker ignores `visibility: "hide"`, so a retained disabled native stayed
 * selectable while /v1/models and the dashboard called it disabled. The emitted catalog omits
 * those rows; the alias and reserve exceptions keep their own carried-through rows.
 */
describe("the emitted catalog omits visibility-hidden rows", () => {
  test("a disabled bare native does not survive to emission", () => {
    const marked = applyNativeVisibility(
      [nativeRow("gpt-5.5"), nativeRow("gpt-6-sol")],
      new Set(["gpt-5.5"]),
    );
    expect(marked.find(row => row.slug === "gpt-5.5")?.visibility).toBe("hide");
    expect(marked.find(row => row.slug === "gpt-6-sol")?.visibility).toBe("list");
    expect(omitVisibilityHiddenRows(marked).map(row => row.slug)).toEqual(["gpt-6-sol"]);
  });

  test("native-alias rows and reserve projections pass through even when marked hide", () => {
    const alias = { ...nativeRow("gpt-6-sol"), visibility: "hide", opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND } as RawEntry;
    const reserve = {
      ...nativeRow(`selector-1/${NATIVE_RESERVE_MODEL}`),
      visibility: "hide",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      [RESERVE_METADATA_SOURCE_FIELD]: RESERVE_LUNA_METADATA_SOURCE,
    } as RawEntry;
    const carried = omitVisibilityHiddenRows([alias, reserve]);
    expect(carried).toHaveLength(2);
  });
});
