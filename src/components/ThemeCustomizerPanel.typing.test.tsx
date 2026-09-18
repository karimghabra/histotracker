// #141: a hex colour can be typed into the theme customizer, one key at a time.
// Real keystrokes (user-event), because fill() and fireEvent.change enter a whole
// valid value at once, which is why tests/e2e/theme-customizer.spec.ts passes.
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ThemeCustomizerPanel } from "./ThemeCustomizerPanel";
import type { Palette as ThemePalette } from "../lib/theme";

function Harness({ seen }: { seen: ThemePalette[] }) {
  const [palette, setPalette] = useState<ThemePalette>({ "--color-surface": "#1a2b3c" });
  return (
    <ThemeCustomizerPanel
      palette={palette}
      onChange={(next) => {
        seen.push(next);
        setPalette(next);
      }}
      onSave={() => {}}
      onCancel={() => {}}
      width={320}
    />
  );
}

it("#141: backspacing and retyping a hex digit edits the field and then the palette", async () => {
  const seen: ThemePalette[] = [];
  const user = userEvent.setup();
  render(<Harness seen={seen} />);
  const field = screen.getByLabelText("Surface hex") as HTMLInputElement;
  expect(field.value).toBe("#1a2b3c");

  await user.click(field);
  await user.keyboard("{End}{Backspace}");
  expect(field.value, "the field after one Backspace").toBe("#1a2b3");

  await user.keyboard("d");
  expect(field.value, "the field after typing the last digit").toBe("#1a2b3d");
  expect(seen[seen.length - 1]?.["--color-surface"], "the palette once the value parses").toBe("#1a2b3d");
});

it("#141: a field cleared to start again can be typed into from '#'", async () => {
  const user = userEvent.setup();
  render(<Harness seen={[]} />);
  const field = screen.getByLabelText("Surface hex") as HTMLInputElement;
  await user.clear(field);
  await user.type(field, "#0b1d2e");
  expect(field.value, "the field after typing a whole colour key by key").toBe("#0b1d2e");
});

it("#141: a half-typed value gives way when the colour is changed from the picker", async () => {
  const user = userEvent.setup();
  render(<Harness seen={[]} />);
  const field = screen.getByLabelText("Surface hex") as HTMLInputElement;
  await user.click(field);
  await user.keyboard("{End}{Backspace}");
  expect(field.value).toBe("#1a2b3");
  fireEvent.change(screen.getByLabelText("Surface"), { target: { value: "#445566" } });
  expect(field.value, "the box follows the picker, not the stale draft").toBe("#445566");
});

it("#141: leaving a half-typed value puts the palette's colour back", async () => {
  const user = userEvent.setup();
  render(<Harness seen={[]} />);
  const field = screen.getByLabelText("Surface hex") as HTMLInputElement;
  await user.click(field);
  await user.keyboard("{End}{Backspace}");
  await user.tab();
  expect(field.value).toBe("#1a2b3c");
});
