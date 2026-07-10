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
