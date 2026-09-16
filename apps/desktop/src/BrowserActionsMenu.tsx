import { useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import { CheckMenuItem, Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";
import { desktop } from "./api";

export type BrowserAction = {
  id: string;
  label: string;
  group: string;
  disabled?: boolean;
  checked?: boolean;
  run: () => void;
};

// Both entry points use the current selection and the same enabled/checked state.
export function useNativeBrowserMenu(actions: BrowserAction[]) {
  const latest = useRef(actions);
  const [native, setNative] = useState<Map<
    string,
    MenuItem | CheckMenuItem
  > | null>(null);
  const [failed, setFailed] = useState(false);
  const signature = JSON.stringify(
    actions.map(({ id, label, disabled, checked }) => ({
      id,
      label,
      disabled,
      checked,
    })),
  );
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    if (!desktop) return;
    let stopped = false;
    const resources: (Menu | Submenu | MenuItem | CheckMenuItem)[] = [];
    let previous: Menu | null = null;
    let installed = false;
    const setup = (async () => {
      const menu = await Menu.default();
      resources.push(menu);
      const items = new Map<string, MenuItem | CheckMenuItem>();
      for (const action of latest.current) {
        const options = {
          id: `browser-${action.id}`,
          text: action.label,
          enabled: false,
          action: () => {
            const current = latest.current.find(
              (item) => item.id === action.id,
            );
            if (
              !stopped &&
              current &&
              !current.disabled &&
              !document.querySelector("dialog[open]")
            )
              current.run();
          },
        };
        const item =
          action.checked === undefined
            ? await MenuItem.new(options)
            : await CheckMenuItem.new({ ...options, checked: action.checked });
        items.set(action.id, item);
        resources.push(item);
      }
      const groups = [...new Set(latest.current.map((action) => action.group))];
      const submenus: Submenu[] = [];
      for (const group of groups) {
        const submenu = await Submenu.new({
          text: group,
          items: latest.current
            .filter((action) => action.group === group)
            .map((action) => items.get(action.id)!),
        });
        resources.push(submenu);
        submenus.push(submenu);
      }
      const operations = await Submenu.new({ text: "操作", items: submenus });
      resources.push(operations);
      await menu.insert(operations, 1);
      if (stopped) return;
      previous = await menu.setAsAppMenu();
      installed = true;
      if (!stopped) setNative(items);
    })().catch(() => {
      if (!stopped) setFailed(true);
    });
    return () => {
      stopped = true;
      void setup
        .then(async () => {
          if (installed && previous) await previous.setAsAppMenu();
          await Promise.allSettled(resources.map((item) => item.close()));
          await previous?.close();
        })
        .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!native) return;
    let stopped = false;
    let queue = Promise.resolve();
    const sync = () => {
      queue = queue
        .then(async () => {
          if (stopped) return;
          const blocked = !!document.querySelector("dialog[open]");
          for (const action of latest.current) {
            if (stopped) return;
            const item = native.get(action.id);
            if (!item) continue;
            await item.setText(action.label);
            await item.setEnabled(!action.disabled && !blocked);
            if (item instanceof CheckMenuItem)
              await item.setChecked(action.checked ?? false);
          }
        })
        .catch(() => {
          if (!stopped) setFailed(true);
        });
    };
    sync();
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.target instanceof HTMLDialogElement ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches("dialog") || node.querySelector("dialog")),
            ),
        )
      )
        sync();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => {
      stopped = true;
      observer.disconnect();
    };
  }, [native, signature]);
  return failed;
}

export function BrowserActionsMenu({
  actions,
  nativeFailed,
}: {
  actions: BrowserAction[];
  nativeFailed: boolean;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        root.current
      )
        root.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && root.current?.open) {
        root.current.open = false;
        root.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details className="browser-actions-menu" ref={root}>
      <summary className="icon-button" aria-label="更多操作" title="更多操作">
        <MoreHorizontal size={19} />
      </summary>
      <div className="browser-actions-popover">
        {nativeFailed && (
          <p className="browser-menu-note">系统菜单不可用，可在这里操作。</p>
        )}
        {[...new Set(actions.map((action) => action.group))].map((group) => (
          <section key={group} aria-label={group}>
            <h2>{group}</h2>
            {actions
              .filter((action) => action.group === group)
              .map((action) => (
                <button
                  key={action.id}
                  type="button"
                  disabled={action.disabled}
                  aria-pressed={action.checked}
                  onClick={() => {
                    if (root.current) root.current.open = false;
                    action.run();
                  }}
                >
                  <span>{action.label}</span>
                  {action.checked && <Check size={14} />}
                </button>
              ))}
          </section>
        ))}
      </div>
    </details>
  );
}
