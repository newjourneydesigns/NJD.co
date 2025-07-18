import { useState } from 'react';
import RichTextEditor from './RichTextEditor';
import Button from './Button';

interface SectionProps {
  isEditing: boolean;
  onDelete?: () => void;
}

export default function Section({ isEditing, onDelete }: SectionProps) {
  const [title, setTitle] = useState('New Section');
  const [content, setContent] = useState('');
  const [buttons, setButtons] = useState<Array<{ id: string; text: string; url: string }>>([]);
  const [isAddingButton, setIsAddingButton] = useState(false);
  const [newButtonText, setNewButtonText] = useState('');
  const [newButtonUrl, setNewButtonUrl] = useState('');

  const addButton = () => {
    if (newButtonText && newButtonUrl) {
      setButtons([...buttons, {
        id: Math.random().toString(36).substr(2, 9),
        text: newButtonText,
        url: newButtonUrl
      }]);
      setNewButtonText('');
      setNewButtonUrl('');
      setIsAddingButton(false);
    }
  };

  const deleteButton = (id: string) => {
    setButtons(buttons.filter(button => button.id !== id));
  };

  return (
    <div className="p-6 bg-slate-800/50 backdrop-blur-sm rounded-xl border border-slate-700/50 shadow-lg transition-all duration-300 hover:shadow-xl">
      <div className="relative">
        {isEditing ? (
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-xl font-bold mb-4 bg-transparent border-b-2 border-dark-100 focus:border-accent-500 
                     outline-none w-full px-1 py-1 transition-colors duration-200"
            placeholder="Section Title"
          />
        ) : (
          <h2 className="text-xl font-bold mb-4 px-1">{title}</h2>
        )}
        
        {isEditing && (
          <button
            onClick={onDelete}
            className="absolute -right-2 -top-2 p-2 text-gray-400 hover:text-red-500 transition-colors duration-200
                     bg-dark-400/80 rounded-lg backdrop-blur-sm border border-dark-200 opacity-0 group-hover:opacity-100"
            title="Delete Section"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="mb-6">
        <RichTextEditor
          content={content}
          editable={isEditing}
          onChange={setContent}
        />
      </div>

      <div className="space-y-3">
        {buttons.map(button => (
          <div key={button.id} className="flex items-center gap-2">
            <Button
              url={button.url}
              isEditing={isEditing}
              onDelete={() => deleteButton(button.id)}
            >
              {button.text}
            </Button>
          </div>
        ))}
      </div>

      {isEditing && (
        <div className="mt-6">
          {isAddingButton ? (
            <div className="space-y-3 bg-dark-400/30 p-4 rounded-lg border border-dark-200">
              <input
                type="text"
                placeholder="Button text"
                value={newButtonText}
                onChange={(e) => setNewButtonText(e.target.value)}
                className="w-full p-2 bg-dark-300 rounded-lg border border-dark-200 focus:border-accent-500 
                         outline-none transition-colors duration-200"
              />
              <input
                type="text"
                placeholder="Button URL"
                value={newButtonUrl}
                onChange={(e) => setNewButtonUrl(e.target.value)}
                className="w-full p-2 bg-dark-300 rounded-lg border border-dark-200 focus:border-accent-500 
                         outline-none transition-colors duration-200"
              />
              <div className="flex gap-2">
                <button
                  onClick={addButton}
                  className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-400 
                           transition-all duration-200 flex-1"
                >
                  Add Button
                </button>
                <button
                  onClick={() => setIsAddingButton(false)}
                  className="px-4 py-2 bg-dark-200 text-gray-300 rounded-lg hover:bg-dark-100 hover:text-white 
                           transition-all duration-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setIsAddingButton(true)}
              className="mt-4 text-accent-400 hover:text-accent-300 transition-colors duration-200 flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              Add Button
            </button>
          )}
        </div>
      )}
    </div>
  );
}
