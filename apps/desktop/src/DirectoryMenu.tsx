import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { useBrowser } from "./store";
import { Modal } from "./components";
import type { EntrySort } from "./types";

const sorts: { value: EntrySort; label: string }[] = [
  { value: "name", label: "名称" },
  { value: "size", label: "大小（从大到小）" },
  { value: "modified", label: "修改时间（从新到旧）" },
];

type Item = {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
  children?: Item[];
};
export type MenuPosition = { x: number; y: number; trigger: HTMLElement };

function MenuPanel({
  items,
  position,
  label,
  perform,
  back,
}: {
  items: Item[];
  position: { x: number; y: number; parentLeft?: number };
  label: string;
  perform: (run: () => void) => void;
  back?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{
    index: number;
    anchor: HTMLButtonElement;
  } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const left =
      position.x + element.offsetWidth > window.innerWidth - 8 &&
      position.parentLeft !== undefined
        ? position.parentLeft - element.offsetWidth
        : position.x;
    element.style.left = `${Math.max(8, Math.min(left, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [position.x, position.y, position.parentLeft]);
  const submenuRect = submenu?.anchor.getBoundingClientRect();
  return (
    <>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className="entry-menu directory-menu"
        style={{ left: position.x, top: position.y }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && back) {
            event.preventDefault();
            back();
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          setSubmenu(null);
          const buttons = [
            ...(ref.current?.querySelectorAll<HTMLButtonElement>(
              ":scope > button:not(:disabled)",
            ) ?? []),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }}
      >
        {items.map((item, index) => (
          <button
            key={item.label}
            className={item.separator ? "directory-menu-separated" : undefined}
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            aria-haspopup={item.children ? "menu" : undefined}
            aria-expanded={item.children ? submenu?.index === index : undefined}
            disabled={item.disabled}
            onPointerEnter={(event) => {
              if (item.children)
                setSubmenu({ index, anchor: event.currentTarget });
              else setSubmenu(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" && item.children) {
                event.preventDefault();
                setSubmenu({ index, anchor: event.currentTarget });
              }
            }}
            onClick={(event) => {
              if (item.children)
                setSubmenu({ index, anchor: event.currentTarget });
              else if (item.run) perform(item.run);
            }}
          >
            <span className="menu-check">
              {item.checked && <Check size={14} />}
            </span>
            <span>{item.label}</span>
            {item.children && (
              <ChevronRight size={14} className="menu-chevron" />
            )}
          </button>
        ))}
      </div>
      {submenu && submenuRect && (
        <MenuPanel
          key={submenu.index}
          items={items[submenu.index].children!}
          label={items[submenu.index].label}
          position={{
            x: submenuRect.right + 5,
            y: submenuRect.top - 5,
            parentLeft: submenuRect.left - 5,
          }}
          perform={perform}
          back={() => {
            submenu.anchor.focus();
            setSubmenu(null);
          }}
        />
      )}
    </>
  );
}

export function DirectoryMenu({
  position,
  onClose,
  canCreate,
  canPaste,
  refreshing,
  onCreate,
  onPaste,
  onRefresh,
  onDetails,
  onOptions,
}: {
  position: MenuPosition;
  onClose: () => void;
  canCreate: boolean;
  canPaste: boolean;
  refreshing: boolean;
  onCreate: () => void;
  onPaste: () => void;
  onRefresh: () => void;
  onDetails: () => void;
  onOptions: () => void;
}) {
  const state = useBrowser();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        onClose();
        position.trigger.focus({ preventScroll: true });
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", keyboard);
    };
  }, [onClose, position]);
  const items: Item[] = [
    { label: "新建文件夹", disabled: !canCreate, run: onCreate },
    { label: "粘贴到当前目录", disabled: !canPaste, run: onPaste },
    { label: "显示简介", separator: true, run: onDetails },
    { label: "刷新", disabled: refreshing, run: onRefresh },
    {
      label: "显示",
      separator: true,
      children: [
        {
          label: "显示隐藏文件",
          checked: state.showHidden,
          run: state.toggleHidden,
        },
        {
          label: "显示详情栏",
          checked: state.showDetails,
          run: state.toggleDetails,
        },
      ],
    },
    { label: "使用群组", checked: state.useGroups, run: state.toggleGroups },
    {
      label: "排序方式",
      children: sorts.map(({ value, label }) => ({
        label,
        checked: state.sort === value,
        run: () => state.setSort(value),
      })),
    },
    { label: "查看显示选项…", run: onOptions },
  ];
  return createPortal(
    <div ref={root} onContextMenu={(event) => event.preventDefault()}>
      <MenuPanel
        items={items}
        position={position}
        label="当前目录操作菜单"
        perform={(run) => {
          onClose();
          position.trigger.focus({ preventScroll: true });
          run();
        }}
      />
    </div>,
    document.body,
  );
}

export function BrowserViewOptions({ onClose }: { onClose: () => void }) {
  const state = useBrowser();
  return (
    <Modal title="显示选项" onClose={onClose}>
      <label className="field-label" htmlFor="browser-sort">
        排序方式
      </label>
      <select
        id="browser-sort"
        className="text-input"
        value={state.sort}
        onChange={(event) => state.setSort(event.target.value as EntrySort)}
      >
        {sorts.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <div className="browser-view-options">
        <label>
          <input
            type="checkbox"
            checked={state.useGroups}
            onChange={state.toggleGroups}
          />
          使用群组（文件夹 / 文件）
        </label>
        <label>
          <input
            type="checkbox"
            checked={state.showHidden}
            onChange={state.toggleHidden}
          />
          显示隐藏文件
        </label>
        <label>
          <input
            type="checkbox"
            checked={state.showDetails}
            onChange={state.toggleDetails}
          />
          显示详情栏
        </label>
      </div>
      <p className="field-help">更改立即生效，并用于之后打开的目录。</p>
      <div className="modal-footer">
        <button className="primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
