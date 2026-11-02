// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../src/components/ui/dropdown-menu.js";

const TOUCH_MIN_H_11 = "[@media(hover:none)_and_(pointer:coarse)]:min-h-11";

afterEach(() => {
  cleanup();
});

describe("dropdown-menu 触控行高（dialogs-4 / settings-2）", () => {
  it("菜单项在 (hover:none) 触屏态抬升为 min-h-11，桌面保持 min-h-7 密度", () => {
    render(
      createElement(
        DropdownMenu,
        { defaultOpen: true },
        createElement(DropdownMenuTrigger, { asChild: true }, createElement("button", null, "菜单")),
        createElement(
          DropdownMenuContent,
          null,
          createElement(DropdownMenuItem, null, "恢复 User 默认"),
          createElement(DropdownMenuCheckboxItem, { checked: true }, "勾选项"),
          createElement(
            DropdownMenuRadioGroup,
            null,
            createElement(DropdownMenuRadioItem, { value: "light" }, "浅色"),
          ),
          createElement(
            DropdownMenuSub,
            null,
            createElement(DropdownMenuSubTrigger, null, "子菜单"),
            createElement(
              DropdownMenuSubContent,
              null,
              createElement(DropdownMenuItem, null, "子项"),
            ),
          ),
        ),
      ),
    );

    for (const label of ["恢复 User 默认", "勾选项", "浅色", "子菜单"]) {
      const row = screen.getByText(label).closest("[data-slot]");
      expect(row, label).not.toBeNull();
      expect(row!.getAttribute("data-slot")).toMatch(/dropdown-menu-(item|checkbox-item|radio-item|sub-trigger)/);
      expect(row!.className, label).toContain("min-h-7");
      expect(row!.className, label).toContain(TOUCH_MIN_H_11);
    }
  });
});
