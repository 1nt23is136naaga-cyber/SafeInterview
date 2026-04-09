import React from 'react';

export default function WarningOverlay({ isVisible, message, onDismiss }) {
    if (!isVisible) return null;

    return (
        <div className="fixed inset-0 z-[9999] bg-red-950 flex flex-col items-center justify-center p-6 animate-pulse-fast backdrop-blur-3xl border-8 border-red-600">
            <div className="max-w-xl text-center">
                <div className="w-24 h-24 mx-auto bg-red-600 rounded-full flex items-center justify-center text-5xl shadow-[0_0_100px_rgba(220,38,38,0.8)] mb-8">
                    ⛔
                </div>
                
                <h1 className="text-4xl md:text-5xl font-black text-white mb-4 tracking-tight drop-shadow-md">
                    CHEATING ATTEMPT DETECTED
                </h1>
                
                <p className="text-xl text-red-100 font-medium mb-8 bg-red-900/50 p-4 rounded-xl border border-red-500/30">
                    {message || "You have left the allowed testing environment."}
                </p>

                <p className="text-sm text-red-300 mb-10 max-w-md mx-auto">
                    This incident has been logged and recorded by the proctoring system. Continuing to violate the environment rules will result in an automatic failure.
                </p>

                <button 
                    onClick={onDismiss}
                    className="bg-white text-red-900 font-bold text-lg px-10 py-4 rounded-2xl hover:bg-red-50 hover:scale-105 transition-all shadow-xl active:scale-95 border-2 border-white focus:outline-none focus:ring-4 focus:ring-red-500 focus:ring-offset-4 focus:ring-offset-red-950"
                >
                    RETURN TO INTERVIEW
                </button>
            </div>
        </div>
    );
}
