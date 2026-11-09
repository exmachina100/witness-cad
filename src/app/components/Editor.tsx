// Monaco code editor with Witness CAD API completions and inline build errors.
import MonacoEditor, { OnMount, loader } from '@monaco-editor/react';
import * as monacoApi from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

// bundle Monaco locally so the editor works offline and behind strict networks
(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco: monacoApi });
import { useEffect, useRef } from 'react';
import { API_DTS } from '../apiTypes';

interface Props {
  path: string;
  value: string;
  onChange: (v: string) => void;
  error?: { line?: number; column?: number; message: string; file?: string } | null;
  dark: boolean;
  onSave?: () => void;
}

export function Editor({ path, value, onChange, error, dark, onSave }: Props) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    const ts = monaco.languages.typescript;
    ts.javascriptDefaults.setCompilerOptions({ allowNonTsExtensions: true, target: ts.ScriptTarget.ES2020, checkJs: false, noLib: false });
    ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, diagnosticCodesToIgnore: [1108] });
    if (!(window as any).__witnessLib) {
      ts.javascriptDefaults.addExtraLib(API_DTS, 'ts:witness-cad.d.ts');
      (window as any).__witnessLib = true;
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave?.());
  };

  useEffect(() => {
    const monaco = monacoRef.current, editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const markers = error && error.line && (!error.file || error.file === path)
      ? [{ startLineNumber: error.line, endLineNumber: error.line, startColumn: 1, endColumn: model.getLineMaxColumn(Math.min(error.line, model.getLineCount())), message: error.message, severity: monaco.MarkerSeverity.Error }]
      : [];
    monaco.editor.setModelMarkers(model, 'witness', markers);
  }, [error, path, value]);

  return (
    <MonacoEditor
      path={path}
      language={path.endsWith('.json') ? 'json' : path.endsWith('.md') ? 'markdown' : 'javascript'}
      value={value}
      theme={dark ? 'vs-dark' : 'light'}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 2, automaticLayout: true, fontLigatures: true, renderWhitespace: 'selection', wordWrap: 'off' }}
    />
  );
}
