// Items screen: searchable list per category, item detail with sensitive-field
// reveal/copy (reauth-gated), and add/edit forms generated from TEMPLATES.
import {
  maskValue,
  TEMPLATES,
  templateFor,
  type CustomField,
  type FieldDef,
  type ItemType,
  type Reminder,
  type VaultItem,
} from "@pw/core";
import { useEffect, useMemo, useState } from "react";
import { GeneratorPanel } from "../components/GeneratorPanel";
import { formatDate, formatDateTime, Modal, Warning } from "../components/ui";
import { CATEGORIES, useApp } from "../ctx";

export function Items() {
  const app = useApp();
  const route = app.route.name === "items" ? app.route : { name: "items" as const, category: "all" as const };
  const cat = CATEGORIES[route.category];
  const { store, rev } = app;

  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [addType, setAddType] = useState<ItemType | null>(null);
  const [editItem, setEditItem] = useState<VaultItem | null>(null);
  const [pickType, setPickType] = useState(false);

  // Honour deep-links from dashboard (open item / quick add).
  useEffect(() => {
    if (route.itemId) setSelId(route.itemId);
    if (route.addType) setAddType(route.addType);
  }, [route.itemId, route.addType]);

  const items = useMemo(() => {
    let list = query.trim()
      ? store.search(query)
      : store.listItems({ includeArchived: showArchived });
    if (!query.trim() && !showArchived) list = list.filter((i) => !i.archived);
    if (cat.types) list = list.filter((i) => cat.types!.includes(i.type));
    return list.sort(
      (a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title),
    );
  }, [store, rev, query, showArchived, cat]);

  const selected = selId ? store.getItem(selId) : undefined;

  const addTypes: ItemType[] = cat.types ?? (Object.keys(TEMPLATES) as ItemType[]);

  const startAdd = () => {
    if (addTypes.length === 1) setAddType(addTypes[0]!);
    else setPickType(true);
  };

  return (
    <div className="screen items-screen">
      <div className="items-list-pane">
        <div className="items-head">
          <h2>{cat.label}</h2>
          <button className="btn primary" onClick={startAdd}>+ Add</button>
        </div>
        <input
          type="search"
          className="search-box"
          placeholder="Search titles, tags, folders…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search items"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />{" "}
          <span>Show archived</span>
        </label>
        <div className="items-list">
          {items.length === 0 && <p className="muted pad">No items yet. Use “+ Add”.</p>}
          {items.map((i) => (
            <div
              key={i.id}
              role="button"
              tabIndex={0}
              className={`list-row item-row ${selId === i.id ? "active" : ""} ${i.archived ? "archived" : ""}`}
              onClick={() => setSelId(i.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setSelId(i.id);
              }}
            >
              <span className="item-icon">{TEMPLATES[i.type].icon}</span>
              <span className="item-title">
                {i.title}
                {i.archived && <span className="chip">archived</span>}
                <span className="item-sub">
                  {i.folder && <span className="chip">📁 {i.folder}</span>}
                  {i.tags.map((t) => (
                    <span key={t} className="chip">#{t}</span>
                  ))}
                </span>
              </span>
              <button
                className={`star ${i.favorite ? "on" : ""}`}
                aria-label={i.favorite ? "Remove favorite" : "Mark favorite"}
                onClick={(e) => {
                  e.stopPropagation();
                  void store.updateItem(i.id, { favorite: !i.favorite }).then(app.refresh);
                }}
              >
                {i.favorite ? "★" : "☆"}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="items-detail-pane">
        {selected ? (
          <ItemDetail
            item={selected}
            onEdit={() => setEditItem(selected)}
            onClosed={() => setSelId(null)}
          />
        ) : (
          <p className="muted pad">Select an item, or add a new one.</p>
        )}
      </div>

      {pickType && (
        <Modal title="What do you want to store?" onClose={() => setPickType(false)}>
          <div className="quick-add">
            {addTypes.map((t) => (
              <button
                key={t}
                className="btn quick-btn"
                onClick={() => {
                  setPickType(false);
                  setAddType(t);
                }}
              >
                {TEMPLATES[t].icon} {TEMPLATES[t].label}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {(addType || editItem) && (
        <ItemForm
          type={editItem ? editItem.type : addType!}
          item={editItem ?? undefined}
          onDone={(id) => {
            setAddType(null);
            setEditItem(null);
            if (id) setSelId(id);
            app.refresh();
          }}
        />
      )}
    </div>
  );
}

/* ---------------- Detail ---------------- */

function ItemDetail(props: { item: VaultItem; onEdit: () => void; onClosed: () => void }) {
  const app = useApp();
  const { store } = app;
  const { item } = props;
  const tpl = templateFor(item.type);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setRevealed(new Set());
    setConfirmDelete(false);
  }, [item.id]);

  const reveal = async (key: string, label: string) => {
    const ok = await app.requestReauth(`Reveal “${label}” — this field is sensitive.`);
    if (!ok) return;
    setRevealed((s) => new Set(s).add(key));
    store.log("sensitive_revealed", `${item.title} — ${label}`);
    await store.touchUsed(item.id);
    app.refresh();
  };

  const hide = (key: string) =>
    setRevealed((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });

  const copySensitive = async (value: string, label: string) => {
    const ok = await app.requestReauth(`Copy “${label}” — this field is sensitive.`);
    if (!ok) return;
    await app.copyWithClear(value, `${label} copied`);
    store.log("password_copied", `${item.title} — ${label}`);
    await store.touchUsed(item.id);
    app.refresh();
  };

  const copyPlain = async (value: string, label: string) => {
    await app.copyWithClear(value, `${label} copied`);
    await store.touchUsed(item.id);
    app.refresh();
  };

  const renderField = (def: FieldDef) => {
    const value = item.fields[def.key];
    if (!value) return null;
    const isRevealed = revealed.has(def.key);
    return (
      <div className="field-row" key={def.key}>
        <div className="field-label">{def.label}</div>
        <div className="field-value">
          {def.sensitive ? (
            <>
              <code className={isRevealed ? "revealed" : "hidden-value"}>
                {isRevealed ? value : def.masked ? maskValue(value) : "••••••••"}
              </code>
              {isRevealed ? (
                <button className="btn tiny" onClick={() => hide(def.key)}>Hide</button>
              ) : (
                <button className="btn tiny" onClick={() => void reveal(def.key, def.label)}>Reveal</button>
              )}
              <button className="btn tiny" onClick={() => void copySensitive(value, def.label)}>Copy</button>
            </>
          ) : (
            <>
              <span className="plain-value">{def.kind === "date" ? formatDate(value) : value}</span>
              <button className="btn tiny" onClick={() => void copyPlain(value, def.label)}>Copy</button>
            </>
          )}
          {def.warning && <div className="field-warning">⚠️ {def.warning}</div>}
        </div>
      </div>
    );
  };

  const renderCustom = (cf: CustomField, idx: number) => {
    if (!cf.value) return null;
    const key = `custom:${idx}`;
    const isRevealed = revealed.has(key);
    return (
      <div className="field-row" key={key}>
        <div className="field-label">{cf.label || "Custom field"}</div>
        <div className="field-value">
          {cf.sensitive ? (
            <>
              <code className={isRevealed ? "revealed" : "hidden-value"}>
                {isRevealed ? cf.value : "••••••••"}
              </code>
              {isRevealed ? (
                <button className="btn tiny" onClick={() => hide(key)}>Hide</button>
              ) : (
                <button className="btn tiny" onClick={() => void reveal(key, cf.label || "Custom field")}>Reveal</button>
              )}
              <button className="btn tiny" onClick={() => void copySensitive(cf.value, cf.label || "Custom field")}>
                Copy
              </button>
            </>
          ) : (
            <>
              <span className="plain-value">{cf.value}</span>
              <button className="btn tiny" onClick={() => void copyPlain(cf.value, cf.label || "Custom field")}>
                Copy
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="item-detail">
      <div className="detail-head">
        <h2>
          {tpl.icon} {item.title}
        </h2>
        <div className="btn-row">
          <button
            className={`star big ${item.favorite ? "on" : ""}`}
            aria-label="Toggle favorite"
            onClick={() => void store.updateItem(item.id, { favorite: !item.favorite }).then(app.refresh)}
          >
            {item.favorite ? "★" : "☆"}
          </button>
          <button className="btn" onClick={props.onEdit}>Edit</button>
          <button
            className="btn"
            onClick={() => void store.setArchived(item.id, !item.archived).then(app.refresh)}
          >
            {item.archived ? "Restore" : "Archive"}
          </button>
          {confirmDelete ? (
            <button
              className="btn danger"
              onClick={() =>
                void store.deleteItem(item.id).then(() => {
                  props.onClosed();
                  app.refresh();
                })
              }
            >
              Really delete?
            </button>
          ) : (
            <button className="btn" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </div>
      </div>

      {(item.folder || item.tags.length > 0) && (
        <p className="muted">
          {item.folder && <span className="chip">📁 {item.folder}</span>}
          {item.tags.map((t) => (
            <span key={t} className="chip">#{t}</span>
          ))}
        </p>
      )}

      {tpl.warning && <Warning>{tpl.warning}</Warning>}

      <div className="fields">{tpl.fields.map(renderField)}</div>
      {item.customFields.length > 0 && (
        <>
          <h4>Custom fields</h4>
          <div className="fields">{item.customFields.map(renderCustom)}</div>
        </>
      )}

      {item.notes && (
        <>
          <h4>Notes</h4>
          <p className="notes">{item.notes}</p>
        </>
      )}

      {item.reminders.length > 0 && (
        <>
          <h4>Reminders</h4>
          <ul className="plain-list">
            {item.reminders.map((r, i) => (
              <li key={i}>
                {r.label} — <strong>{formatDate(r.date)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="muted small">
        Created {formatDateTime(item.createdAt)} · Updated {formatDateTime(item.updatedAt)}
        {item.lastUsedAt && <> · Last used {formatDateTime(item.lastUsedAt)}</>}
      </p>
    </div>
  );
}

/* ---------------- Add / edit form ---------------- */

function ItemForm(props: { type: ItemType; item?: VaultItem; onDone: (id?: string) => void }) {
  const app = useApp();
  const { store } = app;
  const tpl = templateFor(props.type);
  const editing = !!props.item;

  const [title, setTitle] = useState(props.item?.title ?? "");
  const [fields, setFields] = useState<Record<string, string>>({ ...(props.item?.fields ?? {}) });
  const [customFields, setCustomFields] = useState<CustomField[]>(
    props.item?.customFields.map((c) => ({ ...c })) ?? [],
  );
  const [notes, setNotes] = useState(props.item?.notes ?? "");
  const [folder, setFolder] = useState(props.item?.folder ?? "");
  const [tags, setTags] = useState(props.item?.tags.join(", ") ?? "");
  const [reminders, setReminders] = useState<Reminder[]>(
    props.item?.reminders.map((r) => ({ ...r })) ?? [],
  );
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [genFor, setGenFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const setField = (key: string, value: string) => setFields((f) => ({ ...f, [key]: value }));

  const toggleVisible = async (def: FieldDef) => {
    if (visible.has(def.key)) {
      setVisible((s) => {
        const n = new Set(s);
        n.delete(def.key);
        return n;
      });
      return;
    }
    // Revealing a stored sensitive value in the edit form needs reauth too.
    if (editing && props.item?.fields[def.key]) {
      const ok = await app.requestReauth(`Show “${def.label}” while editing.`);
      if (!ok) return;
      store.log("sensitive_revealed", `${props.item.title} — ${def.label}`);
      await store.persist();
    }
    setVisible((s) => new Set(s).add(def.key));
  };

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const cleanFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) if (v.trim() !== "") cleanFields[k] = v;
      const data = {
        title: title.trim(),
        fields: cleanFields,
        customFields: customFields.filter((c) => c.label.trim() || c.value.trim()),
        notes,
        folder: folder.trim() || null,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        reminders: reminders.filter((r) => r.label.trim() && r.date),
      };
      if (editing) {
        await store.updateItem(props.item!.id, data);
        props.onDone(props.item!.id);
      } else {
        const item = await store.addItem({ type: props.type, ...data });
        props.onDone(item.id);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const inputFor = (def: FieldDef) => {
    const value = fields[def.key] ?? "";
    if (def.kind === "multiline") {
      return (
        <textarea
          value={value}
          onChange={(e) => setField(def.key, e.target.value)}
          rows={3}
          placeholder={def.placeholder}
        />
      );
    }
    if (def.kind === "date") {
      return <input type="date" value={value} onChange={(e) => setField(def.key, e.target.value)} />;
    }
    const secret = def.kind === "password" || def.kind === "pin" || def.sensitive;
    return (
      <div className="input-row">
        <input
          type={secret && !visible.has(def.key) ? "password" : "text"}
          value={value}
          onChange={(e) => setField(def.key, e.target.value)}
          placeholder={def.placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        {secret && (
          <button type="button" className="btn tiny" onClick={() => void toggleVisible(def)}>
            {visible.has(def.key) ? "Hide" : "Show"}
          </button>
        )}
        {(def.kind === "password" || def.kind === "pin") && (
          <button type="button" className="btn tiny" onClick={() => setGenFor(def.key)}>
            Generate
          </button>
        )}
      </div>
    );
  };

  return (
    <Modal title={editing ? `Edit — ${props.item!.title}` : `New ${tpl.label}`} onClose={() => props.onDone()} wide>
      {tpl.warning && <Warning>{tpl.warning}</Warning>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && !busy) void save();
        }}
      >
        <label className="field">
          <span>Title *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder={`e.g. ${tpl.label} — my main`} />
        </label>

        <div className="form-grid">
          {tpl.fields.map((def) => (
            <label className="field" key={def.key}>
              <span>{def.label}</span>
              {inputFor(def)}
              {def.warning && <span className="field-warning">⚠️ {def.warning}</span>}
            </label>
          ))}
        </div>

        <h4>Custom fields</h4>
        {customFields.map((cf, i) => (
          <div className="custom-field-row" key={i}>
            <input
              placeholder="Label"
              value={cf.label}
              onChange={(e) =>
                setCustomFields((a) => a.map((c, j) => (j === i ? { ...c, label: e.target.value } : c)))
              }
            />
            <input
              placeholder="Value"
              type={cf.sensitive ? "password" : "text"}
              value={cf.value}
              autoComplete="off"
              onChange={(e) =>
                setCustomFields((a) => a.map((c, j) => (j === i ? { ...c, value: e.target.value } : c)))
              }
            />
            <label className="check">
              <input
                type="checkbox"
                checked={cf.sensitive}
                onChange={(e) =>
                  setCustomFields((a) =>
                    a.map((c, j) => (j === i ? { ...c, sensitive: e.target.checked } : c)),
                  )
                }
              />{" "}
              <span>Sensitive</span>
            </label>
            <button type="button" className="btn tiny" onClick={() => setCustomFields((a) => a.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn tiny"
          onClick={() => setCustomFields((a) => [...a, { label: "", value: "", sensitive: false }])}
        >
          + Add custom field
        </button>

        <h4>Reminders</h4>
        {reminders.map((r, i) => (
          <div className="custom-field-row" key={i}>
            <input
              placeholder="e.g. Premium due / Card expiry"
              value={r.label}
              onChange={(e) => setReminders((a) => a.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            />
            <input
              type="date"
              value={r.date}
              onChange={(e) => setReminders((a) => a.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
            />
            <button type="button" className="btn tiny" onClick={() => setReminders((a) => a.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="btn tiny" onClick={() => setReminders((a) => [...a, { label: "", date: "" }])}>
          + Add reminder
        </button>

        <label className="field">
          <span>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Folder</span>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. Family / Work" />
          </label>
          <label className="field">
            <span>Tags (comma separated)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. bank, primary" />
          </label>
        </div>

        {err && <p className="error">{err}</p>}
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => props.onDone()} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim() || busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add item"}
          </button>
        </div>
      </form>

      {genFor && (
        <Modal title="Generate password" onClose={() => setGenFor(null)}>
          <GeneratorPanel
            onUse={(v) => {
              setField(genFor, v);
              setGenFor(null);
              app.toast("Generated password inserted", "success");
            }}
          />
        </Modal>
      )}
    </Modal>
  );
}
