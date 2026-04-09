import React, { useState, useRef } from 'react';
import { uploadResume, verifyResumeAnswer } from '../api';

export default function ResumeVerification({ onComplete }) {
    const [step, setStep] = useState('upload'); // 'upload' | 'loading' | 'questions' | 'result'
    const [resumeData, setResumeData] = useState(null);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [results, setResults] = useState([]);
    const [isRecording, setIsRecording] = useState(false);
    const [timer, setTimer] = useState(0);
    const [isProcessing, setIsProcessing] = useState(false);

    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const timerIntervalRef = useRef(null);

    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setStep('loading');
        try {
            const data = await uploadResume(file);
            setResumeData(data);
            setStep('questions');
        } catch (err) {
            alert("Failed to process resume: " + (err.response?.data?.detail || err.message));
            setStep('upload');
        }
    };

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream);
            mediaRecorderRef.current = recorder;
            audioChunksRef.current = [];

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };

            recorder.onstop = async () => {
                const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(blob);
                reader.onloadend = async () => {
                    const base64Audio = reader.result;
                    await submitAnswer(base64Audio);
                };
                stream.getTracks().forEach(t => t.stop());
            };

            recorder.start();
            setIsRecording(true);
            setTimer(0);
            timerIntervalRef.current = setInterval(() => {
                setTimer(prev => prev + 1);
            }, 1000);
        } catch (err) {
            alert("Microphone access is required for this round.");
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            clearInterval(timerIntervalRef.current);
        }
    };

    const submitAnswer = async (base64Audio) => {
        setIsProcessing(true);
        try {
            const currentQuestion = resumeData.questions[currentQuestionIndex];
            const evalResult = await verifyResumeAnswer(base64Audio, currentQuestion, resumeData.resume_text);
            
            const newResults = [...results, {
                question: currentQuestion,
                ...evalResult
            }];
            setResults(newResults);

            if (currentQuestionIndex < resumeData.questions.length - 1) {
                setCurrentQuestionIndex(prev => prev + 1);
            } else {
                setStep('result');
            }
        } catch (err) {
            alert("Error verifying answer: " + err.message);
        } finally {
            setIsProcessing(false);
        }
    };

    if (step === 'upload') {
        return (
            <div className="max-w-2xl mx-auto py-10 animate-fade-in">
                <div className="glass-card p-10 text-center border-dashed border-2 border-white/20 hover:border-primary/50 transition-all">
                    <div className="text-6xl mb-6">📄</div>
                    <h2 className="text-2xl font-bold text-white mb-2">Resume Verification Round</h2>
                    <p className="text-gray-400 mb-8">
                        Upload your PDF resume. Our AI will analyze your claims and generate technical questions to verify your expertise.
                    </p>
                    <label className="btn-primary cursor-pointer inline-flex items-center gap-2 px-8 py-3">
                        <span>📁</span> Choose PDF Resume
                        <input type="file" className="hidden" accept=".pdf" onChange={handleFileUpload} />
                    </label>
                </div>
            </div>
        );
    }

    if (step === 'loading') {
        return (
            <div className="max-w-md mx-auto py-20 text-center animate-pulse">
                <div className="text-4xl mb-4">🧠</div>
                <h3 className="text-xl font-semibold text-white mb-2">Analyzing Resume...</h3>
                <p className="text-gray-500 text-sm mb-6">Identifying skills and generating technical verification questions.</p>
                <button 
                  onClick={() => onComplete()}
                  className="text-gray-500 hover:text-white text-xs underline"
                >
                  Cancel & Go Back
                </button>
            </div>
        );
    }

    if (step === 'questions') {
        const currentQuestion = resumeData.questions[currentQuestionIndex];
        return (
            <div className="max-w-3xl mx-auto py-8 animate-slide-up">
                <button 
                  onClick={() => onComplete()}
                  className="mb-4 text-gray-500 hover:text-white text-xs flex items-center gap-1 transition-colors"
                >
                  <span>←</span> Back to Dashboard
                </button>
                <div className="mb-6 flex items-center justify-between">
                    <span className="text-primary font-bold tracking-wider text-xs uppercase bg-primary/10 px-3 py-1 rounded-full border border-primary/20">
                        Question {currentQuestionIndex + 1} of {resumeData.questions.length}
                    </span>
                    <div className="flex items-center gap-2 text-gray-500 text-sm">
                        <span className="w-2 h-2 rounded-full bg-emerald-500"></span> Live Verification Active
                    </div>
                </div>

                <div className="glass-card p-8 mb-8">
                    <h3 className="text-xl font-medium text-white leading-relaxed mb-8 italic">
                        "{currentQuestion}"
                    </h3>

                    <div className="flex flex-col items-center justify-center p-10 border-t border-white/5 bg-white/5 rounded-2xl">
                        {isProcessing ? (
                            <div className="text-center py-4">
                                <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                                <p className="text-primary font-medium">Evaluating Answer...</p>
                            </div>
                        ) : isRecording ? (
                            <div className="text-center">
                                <div className="flex items-center justify-center gap-4 mb-6">
                                    <div className="w-4 h-4 rounded-full bg-red-500 animate-ping"></div>
                                    <span className="text-white font-mono text-xl">{timer}s</span>
                                </div>
                                <button 
                                    onClick={stopRecording}
                                    className="bg-red-600 hover:bg-red-700 text-white font-bold px-10 py-4 rounded-2xl shadow-xl transition-all"
                                >
                                    Stop & Submit Answer
                                </button>
                            </div>
                        ) : (
                            <button 
                                onClick={startRecording}
                                className="btn-primary text-lg px-12 py-5 rounded-2xl shadow-[0_0_30px_rgba(var(--color-primary),0.3)]"
                            >
                                🎤 Record My Answer
                            </button>
                        )}
                    </div>
                </div>
                
                <p className="text-center text-gray-500 text-xs">
                    Please provide a detailed, technical response. Your depth of knowledge will be compared against your resume.
                </p>
            </div>
        );
    }

    if (step === 'result') {
        const averageScore = results.reduce((acc, curr) => acc + curr.legitimacy_score, 0) / results.length;
        const totalVerdict = averageScore > 0.6 ? 'LEGiT' : 'QUESTIONABLE';

        return (
            <div className="max-w-4xl mx-auto py-10 animate-fade-in">
                <div className={`glass-card p-8 mb-8 border-l-4 ${totalVerdict === 'LEGiT' ? 'border-emerald-500' : 'border-red-500'}`}>
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-2xl font-bold text-white">Full Verification Report</h2>
                        <div className={`px-4 py-2 rounded-xl font-bold ${totalVerdict === 'LEGiT' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                           OVERALL: {totalVerdict}
                        </div>
                    </div>
                    
                    <div className="space-y-6">
                        {results.map((res, i) => (
                            <div key={i} className="bg-black/30 p-5 rounded-2xl border border-white/5">
                                <p className="text-gray-500 text-xs mb-1">QUESTION {i+1}</p>
                                <p className="text-white font-medium mb-3 italic">"{res.question}"</p>
                                
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                    <div className="bg-white/5 p-3 rounded-lg">
                                        <p className="text-gray-500 text-[10px] uppercase font-bold mb-1">Your Answer</p>
                                        <p className="text-gray-300 text-sm line-clamp-3">"{res.transcript}"</p>
                                    </div>
                                    <div className="bg-white/5 p-3 rounded-lg border border-white/10">
                                        <p className="text-gray-500 text-[10px] uppercase font-bold mb-1">AI Verdict</p>
                                        <div className="flex items-center justify-between">
                                            <span className={`font-bold ${res.verdict === 'Legit' ? 'text-emerald-400' : 'text-red-400'}`}>{res.verdict}</span>
                                            <span className="text-white text-xs bg-white/10 px-2 py-0.5 rounded">{(res.legitimacy_score * 100).toFixed(0)}%</span>
                                        </div>
                                        <p className="text-gray-400 text-xs mt-2 italic leading-tight">"{res.explanation}"</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    <button 
                        onClick={() => onComplete()}
                        className="mt-10 w-full btn-secondary py-4"
                    >
                        Back to Dashboard
                    </button>
                </div>
            </div>
        );
    }

    return null;
}
