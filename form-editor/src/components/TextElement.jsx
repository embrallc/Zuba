import { Node } from "@tiptap/core";
import Color from "@tiptap/extension-color";
import TextStyle from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { MIME } from "../dnd";
import { useEditorStore } from "../store";

// Inline atom node for data bindings dropped INTO rich text. Stored in the
// Tiptap JSON as {type:"bindingChip", attrs:{key,label}}; the report
// generator swaps it for the resolved value.
const BindingChip = Node.create({
  name: "bindingChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { key: { default: "" }, label: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-binding-key]",
        getAttrs: (el) => ({
          key: el.getAttribute("data-binding-key"),
          label: el.getAttribute("data-binding-label"),
        }),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "span",
      {
        class: "binding-chip",
        "data-binding-key": node.attrs.key,
        "data-binding-label": node.attrs.label,
      },
      `{${node.attrs.label}}`,
    ];
  },
  renderText({ node }) {
    return `{${node.attrs.label}}`;
  },
});

// Active editor instances, keyed by element id — the floating text toolbar
// needs to reach the editor for whichever element is in edit mode.
export const textEditors = new Map();

export default function TextElement({ bandId, el, editing }) {
  const updateNode = useEditorStore((s) => s.updateNode);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      Underline,
      TextStyle,
      Color,
      BindingChip,
    ],
    content: el.content,
    editable: false,
    editorProps: {
      attributes: { class: "tiptap" },
      // Binding pills dragged from the palette drop at the caret position.
      handleDrop(view, event) {
        const raw = event.dataTransfer?.getData(MIME.binding);
        if (!raw) return false;
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (_) {
          return false;
        }
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const pos = coords?.pos ?? view.state.selection.from;
        const node = view.state.schema.nodes.bindingChip.create({
          key: payload.key,
          label: payload.label,
        });
        view.dispatch(view.state.tr.insert(pos, node));
        return true;
      },
    },
    onUpdate({ editor }) {
      // Editing session already snapshotted once by startEditText, so the
      // whole session collapses to a single undo step.
      updateNode(
        { kind: "element", bandId, id: el.id },
        { content: editor.getJSON() },
        { transient: true },
      );
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editing);
    if (editing) {
      textEditors.set(el.id, editor);
      editor.commands.focus("end");
    } else {
      textEditors.delete(el.id);
    }
    return () => textEditors.delete(el.id);
  }, [editor, editing, el.id]);

  // Undo/redo replaces the schema from outside the editor — resync content
  // whenever we're not the active editing surface.
  useEffect(() => {
    if (!editor || editing) return;
    const current = JSON.stringify(editor.getJSON());
    const incoming = JSON.stringify(el.content);
    if (current !== incoming) {
      editor.commands.setContent(el.content, false);
    }
  }, [editor, editing, el.content]);

  const s = el.style ?? {};
  return (
    <div
      className="el-text"
      style={{
        width: "100%",
        height: "100%",
        fontSize: s.fontSize ?? 14,
        color: s.color ?? "#111827",
        textAlign: s.align ?? "left",
        lineHeight: 1.35,
        cursor: editing ? "text" : "default",
      }}
    >
      <EditorContent editor={editor} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
