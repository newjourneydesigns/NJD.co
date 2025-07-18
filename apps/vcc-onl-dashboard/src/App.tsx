import { useState } from 'react';
import Section from './components/Section';

function App() {
  const [isEditing, setIsEditing] = useState(false);
  const [sections, setSections] = useState([{ id: '1' }]);

  const addSection = () => {
    setSections([...sections, { id: Math.random().toString(36).substr(2, 9) }]);
  };

  const deleteSection = (id: string) => {
    setSections(sections.filter(section => section.id !== id));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white">
      <div className="mx-auto min-h-screen">
        {/* Header */}
        <header className="bg-black/30 backdrop-blur-sm border-b border-slate-700/50 sticky top-0 z-10">
          <div className="container mx-auto px-6 py-4">
            <div className="flex justify-between items-center">          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 text-transparent bg-clip-text">
            Content Editor
          </h1>
              <div className="flex items-center gap-6">
                <label 
                  className="flex items-center gap-3 cursor-pointer select-none group" 
                  onClick={() => setIsEditing(!isEditing)}
                >
                  <div                className={`w-14 h-7 flex items-center rounded-full p-1 transition-all duration-300 ease-out shadow-inner ${
                  isEditing ? 'bg-blue-500' : 'bg-slate-700'
                }`}>
                    <div className={`bg-white w-5 h-5 rounded-full shadow-md transform transition-all duration-300 ease-out group-hover:scale-110 ${
                      isEditing ? 'translate-x-7' : ''
                    }`} />
                  </div>
                  <span className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors">
                    Edit Mode
                  </span>
                </label>
                {isEditing && (
                  <button
                    onClick={addSection}
                    className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-400 active:bg-accent-600 
                             transition-all duration-200 shadow-soft hover:shadow-lg hover:-translate-y-0.5 
                             focus:outline-none focus:ring-2 focus:ring-accent-400 focus:ring-offset-2 focus:ring-offset-dark-400"
                  >
                    <span className="flex items-center gap-2">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                      </svg>
                      Add Section
                    </span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="container mx-auto px-6 py-8">
          <div className="space-y-6">
            {sections.map(section => (
              <Section
                key={section.id}
                isEditing={isEditing}
                onDelete={() => deleteSection(section.id)}
              />
            ))}
          </div>
          
          {/* Empty State */}
          {sections.length === 0 && (
            <div className="text-center py-16">
              <p className="text-gray-400 mb-4">No sections yet</p>
              {isEditing && (
                <button
                  onClick={addSection}
                  className="px-4 py-2 bg-dark-100 text-gray-300 rounded-lg hover:bg-dark-50 hover:text-white
                           transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-accent-400"
                >
                  Create your first section
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
