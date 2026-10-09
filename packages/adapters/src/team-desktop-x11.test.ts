import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TEAM_DESKTOP_X11_DIR,
  teamDesktopIndexFromXSocket,
  watchTeamDesktopXSockets,
} from "./team-desktop-x11.js";

describe("team desktop X socket names", () => {
  it("accepts only X101-X150", () => {
    expect(TEAM_DESKTOP_X11_DIR).toBe("/tmp/.X11-unix");
    expect(teamDesktopIndexFromXSocket("X101")).toBe(101);
    expect(teamDesktopIndexFromXSocket("X150")).toBe(150);
    expect(teamDesktopIndexFromXSocket("X110")).toBe(110);
    for (const name of ["X1", "X20", "X100", "X151", "X1010", "X0101", "", null, undefined]) {
      expect(teamDesktopIndexFromXSocket(name)).toBeUndefined();
    }
  });

  it("debounces one display and ignores seat sockets", async () => {
    const gone: number[] = [];
    let listener: ((event: string, filename: string | Buffer | null) => void) | undefined;
    const handle = watchTeamDesktopXSockets({
      directory: "/unused",
      debounceMs: 20,
      socketExists: async () => false,
      watchDirectory: (_directory, next) => {
        listener = next;
        return { close() {} };
      },
      onGone: (displayIndex) => {
        gone.push(displayIndex);
      },
    });
    try {
      if (!listener) throw new Error("display watch did not start");
      listener("rename", "X20");
      listener("rename", "X100");
      listener("rename", "X151");
      listener("rename", "X1010");
      listener("rename", null);
      listener("rename", "X101");
      listener("rename", "X101");
      listener("change", Buffer.from("X101"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(gone).toEqual([]);
      await vi.waitFor(() => expect(gone).toEqual([101]));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(gone).toEqual([101]);
    } finally {
      handle.close();
    }
  });

  it("does not report a socket that comes back before the debounce", async () => {
    let present = false;
    const gone: number[] = [];
    let listener: ((event: string, filename: string) => void) | undefined;
    const handle = watchTeamDesktopXSockets({
      directory: "/unused",
      debounceMs: 20,
      socketExists: async () => present,
      watchDirectory: (_directory, next) => {
        listener = next;
        return { close() {} };
      },
      onGone: (displayIndex) => {
        gone.push(displayIndex);
      },
    });
    try {
      if (!listener) throw new Error("display watch did not start");
      listener("rename", "X150");
      present = true;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(gone).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("reports a real socket removal once and ignores a seat file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "team-x11-watch-"));
    const gone: number[] = [];
    await writeFile(path.join(dir, "X121"), "");
    await writeFile(path.join(dir, "X3"), "");
    const handle = watchTeamDesktopXSockets({
      directory: dir,
      debounceMs: 20,
      onGone: (displayIndex) => {
        gone.push(displayIndex);
      },
    });
    try {
      await rm(path.join(dir, "X3"));
      await rm(path.join(dir, "X121"));
      await vi.waitFor(() => expect(gone).toEqual([121]));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(gone).toEqual([121]);
    } finally {
      handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
