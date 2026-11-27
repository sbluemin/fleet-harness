// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { getMobileDestination, readDestinationFromUrl, setMobileDestination } from "../core/client/src/chrome/mobile/mobile-store.js";

afterEach(() => setMobileDestination({ kind: "home" }));

it("gives a taskforce its own root address without pushing history", () => {
  const length = window.history.length;
  setMobileDestination({ kind: "taskforce", id: "tf-1" });
  expect(getMobileDestination()).toEqual({ kind: "taskforce", id: "tf-1" });
  expect(new URL(window.location.href).searchParams.get("dest")).toBe("taskforce:tf-1");
  setMobileDestination({ kind: "taskforce", id: "tf-2" });
  expect(new URL(window.location.href).searchParams.get("dest")).toBe("taskforce:tf-2");
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?dest=taskforce:tf-9`);
  expect(readDestinationFromUrl()).toEqual({ kind: "taskforce", id: "tf-9" });
  setMobileDestination({ kind: "home" });
  expect(new URL(window.location.href).searchParams.get("dest")).toBeNull();
  expect(window.history.length).toBe(length);
});
