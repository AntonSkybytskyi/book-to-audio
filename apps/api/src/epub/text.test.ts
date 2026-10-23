import { describe, expect, it } from "vitest";
import { cleanParagraph, extractText } from "./text.js";

const doc = (body: string) =>
  extractText(`<html><head><title>T</title></head><body>${body}</body></html>`);

describe("extractText", () => {
  it("turns block elements into paragraphs and collapses whitespace", () => {
    const { paragraphs } = doc(
      "<h1>Title</h1><p>One\n   two   <b>three</b></p><div>Four<br/>Five</div>",
    );

    expect(paragraphs).toEqual(["Title", "One two three", "Four", "Five"]);
  });

  it("decodes entities and strips invisible characters", () => {
    const { paragraphs } = doc("<p>Tom &amp; Jerry&nbsp;&mdash; caf&eacute; soft­hyphen</p>");

    expect(paragraphs).toEqual(["Tom & Jerry — café softhyphen"]);
  });

  it("drops images, figures, tables, scripts and nav", () => {
    const { paragraphs } = doc(
      `<p>Keep</p><img src="a.png" alt="alt text"/><figure><img src="b.png"/><figcaption>Caption</figcaption></figure>` +
        `<table><tr><td>cell</td></tr></table><script>var x = 1;</script><nav><ol><li>Toc item</li></ol></nav><p>Also keep</p>`,
    );

    expect(paragraphs).toEqual(["Keep", "Also keep"]);
  });

  it("drops footnote markers and footnote bodies", () => {
    const { paragraphs } = doc(
      `<p>Text<a epub:type="noteref" href="#n1">1</a> goes<sup><a href="#n2">2</a></sup> on[12].</p>` +
        `<p>Role<a role="doc-noteref" href="#n3">3</a> too.</p>` +
        `<aside epub:type="footnote" id="n1"><p>1. The note body</p></aside>` +
        `<section role="doc-endnotes"><p>Endnote body</p></section>`,
    );

    expect(paragraphs).toEqual(["Text goes on.", "Role too."]);
  });

  it("keeps a superscript that is not a link", () => {
    expect(doc("<p>10<sup>th</sup> floor</p>").paragraphs).toEqual(["10th floor"]);
  });

  it("drops paragraphs with nothing to read", () => {
    expect(doc("<p>* * *</p><p> </p><p>Real</p>").paragraphs).toEqual(["Real"]);
  });

  it("records the paragraph index that each id starts at", () => {
    const { anchors } = doc(
      `<p>zero</p><a id="mark"></a><h2 id="two">Two</h2><p><span id="inner">x</span> y</p>`,
    );

    expect(anchors.get("mark")).toBe(1);
    expect(anchors.get("two")).toBe(1);
    expect(anchors.get("inner")).toBe(2);
  });

  it("uses the first h1 to h3 as heading, else the title", () => {
    expect(doc("<h2>Hello</h2><h1>Later</h1>").heading).toBe("Hello");
    expect(doc("<p>x</p>").heading).toBe("T");
  });

  it("survives deep nesting by flattening it", () => {
    const deep = "<div>".repeat(1500) + "bottom" + "</div>".repeat(1500);

    expect(doc(deep).paragraphs).toEqual(["bottom"]);
  });

  it("rejects nesting that only a hostile file has, quickly", () => {
    const started = Date.now();

    expect(() => doc("<div>".repeat(400_000) + "bottom")).toThrow(/nested too deeply/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("tolerates unclosed and self-closed tags", () => {
    expect(doc("<p>one<p>two<br><p/>three").paragraphs).toEqual(["one", "two", "three"]);
  });
});

describe("cleanParagraph", () => {
  it("removes bracketed note numbers only", () => {
    expect(cleanParagraph("See [3] and [note] and [1234].")).toBe("See and [note] and [1234].");
  });
});
