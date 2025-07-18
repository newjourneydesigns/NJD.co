import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { useEffect } from 'react';

const theme = {
  paragraph: 'mb-2',
  text: {
    bold: 'font-bold',
    italic: 'italic',
    underline: 'underline',
  },
};

const initialConfig = {
  namespace: 'MyEditor',
  theme,
  onError: (error: Error) => console.error(error),
};

interface RichTextEditorProps {
  content?: string;
  editable?: boolean;
  onChange?: (content: string) => void;
}

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  return <>{children}</>;
};

export default function RichTextEditor({ content = '', editable = true, onChange }: RichTextEditorProps) {
  function OnChangePlugin({ onChange }: { onChange?: (content: string) => void }) {
    const [editor] = useLexicalComposerContext();
    
    useEffect(() => {
      return editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const json = JSON.stringify(editorState.toJSON());
          onChange?.(json);
        });
      });
    }, [editor, onChange]);

    return null;
  }

  return (
    <LexicalComposer initialConfig={{ ...initialConfig, editable }}>
      <div className="min-h-[100px] rounded-lg bg-gray-800 p-4">
        <RichTextPlugin
          contentEditable={<ContentEditable className="outline-none" />}
          placeholder={<div className="text-gray-500">Start typing...</div>}
          ErrorBoundary={ErrorBoundary}
        />
        <HistoryPlugin />
        {onChange && <OnChangePlugin onChange={onChange} />}
      </div>
    </LexicalComposer>
  );
}
