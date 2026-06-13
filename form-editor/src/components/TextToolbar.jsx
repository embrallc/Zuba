import { useEffect, useReducer } from "react";
import { useEditorStore } from "../store";
import { textEditors } from "./TextElement";

// Floating toolbar for the text element currently in edit mode. Re-renders on
// every editor transaction so active states track the caret.
export default function TextToolbar() {
  const editingTextId = useEditorStore((s) => s.editingTextId);
  const stopEditText = useEditorStore((s) => s.stopEditText);
  const [, forceUpdate] = useReducer((x) => x + 1, 0);
  const editor = textEditors.get(editingTextId);

  useEffect(() => {
    if (!editor) return;
    editor.on("transaction", forceUpdate);
    return () => editor.off("transaction", forceUpdate);
  }, [editor]);

  if (!editor) return null;

  const btn = (label, isActive, run, title) => (
    <button
      type="button"
      title={title}
      className={isActive ? "active" : ""}
      onMouseDown={(e) => {
        // Keep focus inside the editor so the selection survives the click.
        e.preventDefault();
        run();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="text-toolbar">
      {btn(<b>B</b>, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "Bold")}
      {btn(<i>I</i>, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "Italic")}
      {btn(<u>U</u>, editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), "Underline")}
      <input
        type="color"
        title="Text color"
        value={editor.getAttributes("textStyle").color ?? "#111827"}
        onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
      />
      {btn("⌫", false, () => editor.chain().focus().unsetAllMarks().run(), "Clear formatting")}
      <button type="button" className="active" onMouseDown={(e) => { e.preventDefault(); stopEditText(); }}>
        Done
      </button>
    </div>
  );
}
