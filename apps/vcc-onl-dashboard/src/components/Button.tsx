import React from 'react';

interface ButtonProps {
  url: string;
  children: React.ReactNode;
  onEdit?: () => void;
  onDelete?: () => void;
  isEditing?: boolean;
}

export default function Button({ url, children, onEdit, onDelete, isEditing = false }: ButtonProps) {
  const baseButtonClasses = 
    "group inline-flex items-center px-4 py-2 rounded-lg font-medium shadow-soft hover:shadow-lg " +
    "transition-all duration-200 hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-accent-400 focus:ring-offset-2 focus:ring-offset-dark-400";
  
  if (isEditing) {
    return (
      <div className="flex items-center gap-2 group/button">
        <a
          href={url}
          className={`${baseButtonClasses} bg-slate-700 text-white hover:bg-slate-600`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="flex items-center gap-2">
            {children}
            <svg className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </span>
        </a>
        <div className="flex -space-x-1">
          <button
            onClick={onEdit}
            className="p-2 text-gray-400 hover:text-accent-400 transition-colors duration-200 
                     bg-dark-300 rounded-l-lg border border-dark-200 hover:border-accent-500 relative z-10"
            title="Edit Button"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="p-2 text-gray-400 hover:text-red-500 transition-colors duration-200 
                     bg-dark-300 rounded-r-lg border border-dark-200 hover:border-red-500 -ml-px"
            title="Delete Button"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <a
      href={url}
      className={`${baseButtonClasses} bg-blue-500 text-white hover:bg-blue-400`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="flex items-center gap-2">
        {children}
        <svg className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </span>
    </a>
  );
}
