import { describe, expect, it } from "vitest";
import { useOutputsHarness } from "../testing/outputs-harness.js";

describe("OutputRepository.invalidate", () => {
  const h = useOutputsHarness();

  it("forgets the built files but keeps the state, and does nothing for a book without a row", () => {
    const id = h.addDoneBook();
    h.outputs.enqueue(id);
    h.outputs.begin(id, h.generation(id));
    h.outputs.complete(id, { generation: h.generation(id), m4bBytes: 5, zipBytes: 6 });
    expect(h.outputs.get(id)).toMatchObject({ state: "ready", builtGeneration: 2, m4bBytes: 5 });

    h.outputs.invalidate(id);

    expect(h.outputs.get(id)).toMatchObject({
      state: "ready",
      builtGeneration: null,
      m4bBytes: null,
      zipBytes: null,
    });
    expect(() => h.outputs.invalidate("nobody")).not.toThrow();
  });
});
