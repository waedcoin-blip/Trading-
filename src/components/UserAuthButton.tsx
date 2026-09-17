import React from 'react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { LogIn, LogOut, User as UserIcon } from 'lucide-react';

export const UserAuthButton: React.FC = () => {
  const { user, loading, signInWithGoogle, signOut } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 bg-[#12161f] border border-[#1e2533] rounded">
        <span className="w-2 h-2 rounded-full bg-gray-500 animate-pulse" />
        <span>Auth...</span>
      </div>
    );
  }

  if (user) {
    return (
      <div className="flex items-center gap-2 bg-[#12161f] border border-[#1e2533] px-2.5 py-1 rounded">
        {user.photoURL ? (
          <img 
            src={user.photoURL} 
            alt={user.displayName || 'User'} 
            className="w-5 h-5 rounded-full object-cover border border-blue-500/30"
            referrerPolicy="no-referrer"
          />
        ) : (
          <UserIcon className="w-4 h-4 text-blue-400" />
        )}
        <span className="text-xs font-semibold text-gray-200 max-w-[120px] truncate" title={user.email || ''}>
          {user.displayName || user.email?.split('@')[0] || 'User'}
        </span>
        <button
          onClick={signOut}
          className="text-gray-400 hover:text-red-400 p-1 transition"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={signInWithGoogle}
      className="flex items-center gap-1.5 px-3 py-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 rounded text-xs font-semibold transition"
      title="Sign in with Google"
    >
      <LogIn className="w-3.5 h-3.5" />
      <span>Sign In</span>
    </button>
  );
};
