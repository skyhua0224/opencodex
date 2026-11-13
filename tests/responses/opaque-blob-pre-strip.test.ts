import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearOpaqueBlobPreStripForTests,
  noteOpaqueBlobRejectedThread,
  prepareOpaqueBlobRecovery,
  shouldPreStripOpaqueBlob,
} from "../../src/server/responses/core-opaque-recovery";
import type { OcxParsedRequest } from "../../src/types";

beforeEach(() => {
  clearOpaqueBlobPreStripForTests();
});

/**
 * A conversation whose opaque state the origin refused once starts the NEXT turn already stripped.
 *
 * The measured shape (2026-09-30, one thread): 37 of 41 turns carried `opaque-blob-rejection`, so
 * every turn paid a refused send plus the stripped rebuild. The strip is what the origin accepts,
 * so the memory only removes a send the origin was going to reject -- and a shed verdict lands on a
 * physical send, which is why the extra one mattered.
 */
describe("opaque blob pre-strip memo", () => {
  test("arms only for the thread that was refused", () => {
    expect(shouldPreStripOpaqueBlob(undefined)).toBe(false);
    expect(shouldPreStripOpaqueBlob("thread-never-refused")).toBe(false);
    noteOpaqueBlobRejectedThread("thread-refused");
    expect(shouldPreStripOpaqueBlob("thread-refused")).toBe(true);
    expect(shouldPreStripOpaqueBlob("thread-never-refused")).toBe(false);
  });

  test("blank thread ids are never memoized", () => {
    noteOpaqueBlobRejectedThread(undefined);
    noteOpaqueBlobRejectedThread("   ");
    expect(shouldPreStripOpaqueBlob("   ")).toBe(false);
    expect(shouldPreStripOpaqueBlob(undefined)).toBe(false);
  });

  test("expires after the hold and is refreshed by a later refusal", () => {
    const t0 = 1_000_000;
    noteOpaqueBlobRejectedThread("thread-expiring", t0);
    expect(shouldPreStripOpaqueBlob("thread-expiring", t0 + 6 * 60 * 60_000 - 1)).toBe(true);
    expect(shouldPreStripOpaqueBlob("thread-expiring", t0 + 6 * 60 * 60_000 + 1)).toBe(false);
    noteOpaqueBlobRejectedThread("thread-expiring", t0 + 5 * 60 * 60_000);
    expect(shouldPreStripOpaqueBlob("thread-expiring", t0 + 6 * 60 * 60_000 + 1)).toBe(true);
  });

  test("the strip it triggers is the one the recovery already applies", () => {
    const parsed = {
      _rawBody: {
        input: [
          { type: "reasoning", id: "rs_foreign", encrypted_content: "gAAAAB-blob" },
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: [{ type: "encrypted_content", encrypted_content: "gAAAAB-blob-2" }],
          },
        ],
      },
    } as unknown as OcxParsedRequest;
    prepareOpaqueBlobRecovery(parsed);
    expect(parsed._stripReasoningEncryptedContent).toBe(true);
    expect(parsed._dropForeignReasoningItemIds).toBe(true);
    const input = (parsed._rawBody as { input: Array<Record<string, unknown>> }).input;
    const output = input[1]!.output as Array<Record<string, unknown>>;
    expect(output[0]!.type).toBe("input_text");
    expect(output[0]!.encrypted_content).toBeUndefined();
  });
});
