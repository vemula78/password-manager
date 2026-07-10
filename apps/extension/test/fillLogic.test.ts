// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { fillCredentials, isVisible } from "../src/lib/fillLogic";

function setBody(html: string) {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("isVisible", () => {
  it("treats a plain input as visible", () => {
    setBody('<input id="a" type="text" />');
    expect(isVisible(document.getElementById("a")!)).toBe(true);
  });
  it("treats display:none as hidden", () => {
    setBody('<input id="a" type="text" style="display:none" />');
    expect(isVisible(document.getElementById("a")!)).toBe(false);
  });
  it("treats visibility:hidden as hidden", () => {
    setBody('<input id="a" type="text" style="visibility:hidden" />');
    expect(isVisible(document.getElementById("a")!)).toBe(false);
  });
  it("treats opacity:0 as hidden (a common honeypot trick)", () => {
    setBody('<input id="a" type="text" style="opacity:0" />');
    expect(isVisible(document.getElementById("a")!)).toBe(false);
  });
  it("treats input[type=hidden] as hidden", () => {
    setBody('<input id="a" type="hidden" />');
    expect(isVisible(document.getElementById("a")!)).toBe(false);
  });
  it("treats aria-hidden on the element as hidden", () => {
    setBody('<input id="a" type="text" aria-hidden="true" />');
    expect(isVisible(document.getElementById("a")!)).toBe(false);
  });
  it("treats an aria-hidden ANCESTOR as hidden", () => {
    setBody('<div aria-hidden="true"><div><input id="a" type="text" /></div></div>');
    expect(isVisible(document.getElementById("a")!)).toBe(false);
  });

  // jsdom has no layout engine, so exercise the geometry rules by stubbing the element's
  // rect methods the way a real browser would report them.
  function mockGeometry(el: HTMLElement, box: { left: number; top: number; width: number; height: number }) {
    const rect = {
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => ({}),
    } as DOMRect;
    el.getClientRects = () => [rect] as unknown as DOMRectList;
    el.getBoundingClientRect = () => rect;
  }

  it("treats a tiny (sub-10px) box as hidden (1x1 honeypots)", () => {
    setBody('<input id="a" type="text" />');
    const el = document.getElementById("a")!;
    mockGeometry(el, { left: 50, top: 50, width: 1, height: 1 });
    expect(isVisible(el)).toBe(false);
  });
  it("treats a box positioned far off-screen (negative) as hidden", () => {
    setBody('<input id="a" type="text" />');
    const el = document.getElementById("a")!;
    mockGeometry(el, { left: -9999, top: 50, width: 200, height: 30 });
    expect(isVisible(el)).toBe(false);
  });
  it("treats a box positioned far beyond the document extents as hidden", () => {
    setBody('<input id="a" type="text" />');
    const el = document.getElementById("a")!;
    mockGeometry(el, { left: 50, top: 99999, width: 200, height: 30 });
    expect(isVisible(el)).toBe(false);
  });
  it("treats a normally-sized on-screen box as visible", () => {
    setBody('<input id="a" type="text" />');
    const el = document.getElementById("a")!;
    mockGeometry(el, { left: 50, top: 50, width: 200, height: 30 });
    expect(isVisible(el)).toBe(true);
  });
});

describe("fillCredentials", () => {
  it("fills the visible password field and username field", () => {
    setBody(
      '<input id="u" type="text" /><input id="p" type="password" />',
    );
    const result = fillCredentials({ username: "alice", password: "s3cret" });
    expect(result.filledUsername).toBe(true);
    expect(result.filledPassword).toBe(true);
    expect((document.getElementById("u") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("p") as HTMLInputElement).value).toBe("s3cret");
  });

  it("does not fill a hidden honeypot username field", () => {
    setBody(
      '<input id="honeypot" type="text" style="display:none" />' +
        '<input id="real" type="text" />' +
        '<input id="p" type="password" />',
    );
    const result = fillCredentials({ username: "alice", password: "s3cret" });
    expect(result.filledUsername).toBe(true);
    expect((document.getElementById("honeypot") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("real") as HTMLInputElement).value).toBe("alice");
  });

  it("skips a hidden password field entirely", () => {
    setBody('<input id="p" type="password" style="display:none" />');
    const result = fillCredentials({ username: null, password: "s3cret" });
    expect(result.filledPassword).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("reports a reason when nothing is fillable", () => {
    setBody("<div>no form here</div>");
    const result = fillCredentials({ username: "alice", password: "s3cret" });
    expect(result.filledUsername).toBe(false);
    expect(result.filledPassword).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("fills the username within the SAME form as the password field, not a decoy elsewhere", () => {
    setBody(
      '<form id="decoy"><input id="decoyUser" type="text" /></form>' +
        '<form id="real"><input id="realUser" type="text" /><input id="p" type="password" /></form>',
    );
    const result = fillCredentials({ username: "alice", password: "s3cret" });
    expect(result.filledUsername).toBe(true);
    expect(result.filledPassword).toBe(true);
    expect((document.getElementById("decoyUser") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("realUser") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("p") as HTMLInputElement).value).toBe("s3cret");
  });

  it("does not fill the username at all if the password's form has no username field", () => {
    setBody(
      '<form id="decoy"><input id="decoyUser" type="text" /></form>' +
        '<form id="real"><input id="p" type="password" /></form>',
    );
    const result = fillCredentials({ username: "alice", password: "s3cret" });
    expect(result.filledPassword).toBe(true);
    expect(result.filledUsername).toBe(false);
    expect((document.getElementById("decoyUser") as HTMLInputElement).value).toBe("");
  });

  it("prefers autocomplete=username within the password's form", () => {
    setBody(
      '<form><input id="other" type="text" /><input id="ac" type="text" autocomplete="username" />' +
        '<input id="p" type="password" /></form>',
    );
    const result = fillCredentials({ username: "alice", password: "pw" });
    expect(result.filledUsername).toBe(true);
    expect((document.getElementById("ac") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("other") as HTMLInputElement).value).toBe("");
  });

  it("still fills a username document-wide when no password fill was requested", () => {
    setBody('<input id="u" type="text" />');
    const result = fillCredentials({ username: "alice", password: null });
    expect(result.filledUsername).toBe(true);
    expect((document.getElementById("u") as HTMLInputElement).value).toBe("alice");
  });

  it("skips disabled and readonly fields", () => {
    setBody(
      '<input id="disabled" type="text" disabled />' +
        '<input id="ro" type="text" readonly />' +
        '<input id="real" type="text" />' +
        '<input id="p" type="password" />',
    );
    const result = fillCredentials({ username: "bob", password: "pw" });
    expect(result.filledUsername).toBe(true);
    expect((document.getElementById("real") as HTMLInputElement).value).toBe("bob");
    expect((document.getElementById("disabled") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("ro") as HTMLInputElement).value).toBe("");
  });
});
