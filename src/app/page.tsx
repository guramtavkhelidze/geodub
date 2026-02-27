"use client";

import { useState, useRef, useEffect } from 'react';
import { Play, Pause, Youtube, Loader2, Languages, Trash2, History } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

interface ProgressState {
  stage: string;
  message?: string;
  current?: number;
  total?: number;
  percent?: number;
  text?: string;
}

interface HistoryItem {
  videoId: string;
  audioUrl: string;
  createdAt: string;
  title?: string | null;
  thumbnail?: string | null;
}

export default function GeoDub() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [pendingResult, setPendingResult] = useState<any>(null);
  const [isGeorgian, setIsGeorgian] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [ytReady, setYtReady] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyMeta, setHistoryMeta] = useState<Record<string, any>>({});

  const audioRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<any>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load history from API and metadata from localStorage
  const loadHistory = async () => {
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      if (data.videos) {
        setHistory(data.videos);
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    }

    // Load metadata from localStorage
    const savedMeta = localStorage.getItem('geodub_history_meta');
    if (savedMeta) {
      try {
        setHistoryMeta(JSON.parse(savedMeta));
      } catch {}
    }
  };

  // Load history on mount
  useEffect(() => {
    loadHistory();
  }, []);

  // Save metadata to localStorage when result changes
  useEffect(() => {
    if (result && result.originalVideoId) {
      const newMeta = {
        ...historyMeta,
        [result.originalVideoId]: {
          title: result.metadata?.title || result.originalVideoId,
          thumbnail: result.metadata?.thumbnail,
        }
      };
      setHistoryMeta(newMeta);
      localStorage.setItem('geodub_history_meta', JSON.stringify(newMeta));
      // Reload history to include new item
      loadHistory();
    }
  }, [result]);

  // Load YouTube IFrame API
  useEffect(() => {
    if (window.YT) {
      setYtReady(true);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      setYtReady(true);
    };
  }, []);

  // Initialize YouTube player when result is ready
  useEffect(() => {
    if (!result || !ytReady) return;

    // Destroy existing player first
    if (playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
    }

    // Small delay to ensure DOM is ready
    setTimeout(() => {
      playerRef.current = new window.YT.Player('yt-player', {
        videoId: result.originalVideoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
        },
        events: {
          onStateChange: (event: any) => {
            if (event.data === window.YT.PlayerState.PLAYING) {
              if (isGeorgian && audioRef.current) {
                audioRef.current.currentTime = playerRef.current.getCurrentTime();
                audioRef.current.play();
              }
              setIsPlaying(true);
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              audioRef.current?.pause();
              setIsPlaying(false);
            }
          },
        },
      });
    }, 100);

    return () => {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [result, ytReady]);

  // Mute/unmute YouTube based on Georgian toggle
  useEffect(() => {
    if (!playerRef.current) return;

    if (isGeorgian) {
      playerRef.current.mute();
      if (isPlaying && audioRef.current) {
        audioRef.current.currentTime = playerRef.current.getCurrentTime();
        audioRef.current.play();
      }
    } else {
      playerRef.current.unMute();
      audioRef.current?.pause();
    }
  }, [isGeorgian, isPlaying]);

  // Update audio progress
  useEffect(() => {
    if (isPlaying && audioRef.current) {
      progressIntervalRef.current = setInterval(() => {
        if (audioRef.current) {
          setAudioProgress(audioRef.current.currentTime);
          setAudioDuration(audioRef.current.duration || 0);
        }
      }, 100);
    } else {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    }

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, [isPlaying]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !playerRef.current) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newTime = percent * audioDuration;

    audioRef.current.currentTime = newTime;
    playerRef.current.seekTo(newTime, true);
  };

  const handleTranslate = async () => {
    setLoading(true);
    setProgress(null);
    setPendingResult(null);

    try {
      const response = await fetch('/api/translate-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('Stream not available');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.stage === 'done') {
                setPendingResult(data);
                setProgress(null);
                loadHistory();
              } else if (data.stage === 'error') {
                setProgress({ stage: 'error', message: data.error });
              } else {
                setProgress(data);
              }
            } catch (e) {
              // Ignore JSON parse errors
            }
          }
        }
      }
    } catch (err) {
      setProgress({ stage: 'error', message: 'დაფიქსირდა შეცდომა' });
    } finally {
      setLoading(false);
    }
  };

  const loadPendingResult = () => {
    if (!pendingResult) return;
    loadFromHistory({
      videoId: pendingResult.originalVideoId,
      audioUrl: pendingResult.translatedAudioUrl,
      createdAt: new Date().toISOString(),
      title: pendingResult.metadata?.title,
      thumbnail: pendingResult.metadata?.thumbnail,
    });
    setPendingResult(null);
  };

  const togglePlay = () => {
    if (!result || !playerRef.current) return;

    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  };

  const getStageLabel = (stage: string) => {
    switch (stage) {
      case 'download': return 'ჩამოტვირთვა';
      case 'translate': return 'თარგმნა';
      case 'tts': return 'გახმოვანება';
      case 'stitch': return 'გაერთიანება';
      default: return stage;
    }
  };

  // Load a video from history
  const loadFromHistory = (item: HistoryItem) => {
    // Reset current player
    if (playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
    }

    // Use item data first, then localStorage as fallback
    const meta = historyMeta[item.videoId] || {};
    setResult({
      success: true,
      originalVideoId: item.videoId,
      translatedAudioUrl: item.audioUrl,
      metadata: {
        title: item.title || meta.title,
        thumbnail: item.thumbnail || meta.thumbnail
      }
    });
    setUrl(`https://www.youtube.com/watch?v=${item.videoId}`);
    setIsPlaying(false);
    setAudioProgress(0);
  };

  // Delete a video from history
  const deleteFromHistory = async (videoId: string) => {
    if (!confirm('დარწმუნებული ხარ რომ გსურს წაშლა?')) return;

    try {
      const res = await fetch(`/api/history/${videoId}`, { method: 'DELETE' });
      const data = await res.json();

      if (data.success) {
        // Remove from history meta
        const newMeta = { ...historyMeta };
        delete newMeta[videoId];
        setHistoryMeta(newMeta);
        localStorage.setItem('geodub_history_meta', JSON.stringify(newMeta));

        // If this was the currently loaded video, clear it
        if (result?.originalVideoId === videoId) {
          setResult(null);
          setUrl('');
          if (playerRef.current) {
            playerRef.current.destroy();
            playerRef.current = null;
          }
        }

        // Reload history
        loadHistory();
      }
    } catch (err) {
      console.error('Failed to delete:', err);
      alert('წაშლა ვერ მოხერხდა');
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ka-GE', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-purple-500/30 flex flex-col">
      {/* Background Gradients */}
      <div className="fixed inset-0 overflow-hidden -z-10">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-900/20 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/20 blur-[120px] rounded-full" />
      </div>

      {/* Header — Logo centered */}
      <header className="flex justify-center items-center py-5 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-gradient-to-br from-purple-500 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/20">
            <Languages className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">
            GeoDub
          </h1>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">

        {/* Left Panel — controls */}
        <div className="w-72 flex-shrink-0 border-r border-white/10 p-5 flex flex-col gap-5 overflow-y-auto">
          <div>
            <h2 className="text-lg font-bold leading-snug mb-1">
              გადათარგმნე იუთუბი <span className="text-purple-500">ქართულად</span>
            </h2>
            <p className="text-gray-500 text-xs leading-relaxed">
              ჩააგდე ლინკი და მიიღე სინქრონული ქართული გახმოვანება AI-ს დახმარებით.
            </p>
          </div>

          {/* Input */}
          <div className="relative group">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-purple-600 to-blue-600 rounded-xl blur opacity-20 group-hover:opacity-40 transition duration-500" />
            <div className="relative flex flex-col gap-2 p-2 bg-white/5 border border-white/10 rounded-xl backdrop-blur-xl">
              <input
                type="text"
                placeholder="YouTube URL ჩასვი აქ..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="bg-transparent px-3 py-2 outline-none text-sm text-white placeholder:text-gray-500 w-full"
              />
              <button
                onClick={handleTranslate}
                disabled={loading || !url}
                className="bg-white text-black font-semibold px-4 py-2.5 rounded-lg hover:bg-gray-200 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Youtube className="w-4 h-4" />}
                {loading ? 'მუშავდება...' : 'გადათარგმნა'}
              </button>
            </div>
          </div>

          {/* Controls — visible when video loaded */}
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-3"
            >
              <button
                onClick={togglePlay}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 rounded-xl transition-all text-sm font-medium"
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {isPlaying ? 'პაუზა' : 'დაკვრა'}
              </button>

              <div className="flex items-center gap-1 bg-white/10 p-1 rounded-lg">
                <button
                  onClick={() => setIsGeorgian(false)}
                  className={`flex-1 py-1.5 rounded-md transition-all text-xs ${!isGeorgian ? 'bg-white text-black font-medium' : 'text-gray-400 hover:text-white'}`}
                >
                  Original
                </button>
                <button
                  onClick={() => setIsGeorgian(true)}
                  className={`flex-1 py-1.5 rounded-md transition-all text-xs ${isGeorgian ? 'bg-purple-600 text-white font-medium' : 'text-gray-400 hover:text-white'}`}
                >
                  ქართული (AI)
                </button>
              </div>

              <p className="text-xs text-gray-600 text-center">Powered by Edge TTS</p>
            </motion.div>
          )}
        </div>

        {/* Center — Video Player */}
        <main className="flex-1 p-5 flex flex-col">
          {result ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-3 h-full"
            >
              <div className="aspect-video rounded-2xl overflow-hidden border border-white/10 bg-black shadow-2xl relative">
                <div id="yt-player" className="absolute inset-0 w-full h-full" />
                <audio ref={audioRef} src={result.translatedAudioUrl} preload="auto" />
              </div>

              {isGeorgian && (
                <div className="space-y-1">
                  <div
                    className="w-full h-2 bg-white/10 rounded-full overflow-hidden cursor-pointer group"
                    onClick={handleProgressClick}
                  >
                    <motion.div
                      className="h-full bg-gradient-to-r from-purple-500 to-blue-500 relative"
                      style={{ width: audioDuration ? `${(audioProgress / audioDuration) * 100}%` : '0%' }}
                      transition={{ duration: 0.1 }}
                    >
                      <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity" />
                    </motion.div>
                  </div>
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>{formatTime(audioProgress)}</span>
                    <span>{formatTime(audioDuration)}</span>
                  </div>
                </div>
              )}
            </motion.div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-3 opacity-20">
                <Youtube className="w-20 h-20 mx-auto" />
                <p className="text-gray-400 text-sm">გადათარგმნე ვიდეო სანახავად</p>
              </div>
            </div>
          )}
        </main>

        {/* History Sidebar */}
        <aside className="w-72 border-l border-white/10 bg-white/[0.02] p-5 overflow-y-auto">
          <div className="flex items-center gap-2 mb-6">
            <History className="w-5 h-5 text-purple-400" />
            <h2 className="text-lg font-semibold">ისტორია</h2>
          </div>

          {history.length === 0 ? (
            <p className="text-gray-500 text-sm">ჯერ არ გაქვს გადათარგმნილი ვიდეო</p>
          ) : (
            <div className="space-y-3">
              {history.map((item) => {
                const isActive = result?.originalVideoId === item.videoId;
                // Use API data first, then localStorage meta as fallback
                const title = item.title || historyMeta[item.videoId]?.title || item.videoId;
                const thumbnail = item.thumbnail || historyMeta[item.videoId]?.thumbnail || `https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`;

                return (
                  <div
                    key={item.videoId}
                    className={`p-3 rounded-xl border transition-all ${
                      isActive
                        ? 'bg-purple-500/20 border-purple-500/50'
                        : 'bg-white/5 border-white/10 hover:bg-white/10'
                    }`}
                  >
                    <div className="flex gap-3">
                      {/* Thumbnail - Small */}
                      <div className="w-16 h-12 flex-shrink-0 relative">
                        <img
                          src={thumbnail}
                          alt=""
                          className="w-full h-full object-cover rounded-md"
                        />
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        {/* Title */}
                        <p className="text-sm font-medium text-white line-clamp-2 leading-tight mb-1">
                          {title}
                        </p>

                        {/* Date */}
                        <p className="text-xs text-gray-500">
                          {formatDate(item.createdAt)}
                        </p>
                      </div>
                    </div>

                    {/* Buttons */}
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => loadFromHistory(item)}
                        disabled={isActive}
                        className={`flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all ${
                          isActive
                            ? 'bg-purple-600 text-white cursor-default'
                            : 'bg-white/10 hover:bg-white/20 text-gray-300'
                        }`}
                      >
                        <Play className="w-3 h-3" />
                        {isActive ? 'აქტიური' : 'ჩართვა'}
                      </button>
                      <button
                        onClick={() => deleteFromHistory(item.videoId)}
                        className="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-all"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      {/* Floating Progress Panel */}
      <AnimatePresence>
        {(loading || pendingResult) && (
          <motion.div
            initial={{ opacity: 0, y: 80, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 80, scale: 0.95 }}
            transition={{ type: 'spring', damping: 20 }}
            className="fixed bottom-6 left-6 z-50 w-72"
          >
            <div className="bg-[#111] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                  {pendingResult ? (
                    <div className="w-2 h-2 rounded-full bg-green-400" />
                  ) : (
                    <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                  )}
                  <span className="text-sm font-medium text-white">
                    {pendingResult ? 'თარგმანი მზადაა!' : 'თარგმნა მიმდინარეობს...'}
                  </span>
                </div>
                {pendingResult && (
                  <button
                    onClick={() => setPendingResult(null)}
                    className="text-gray-500 hover:text-white text-xs transition-colors"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Progress content */}
              {loading && progress && !pendingResult && (
                <div className="px-4 py-3 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-purple-400">{getStageLabel(progress.stage)}</span>
                    {progress.percent !== undefined && (
                      <span className="text-gray-400">{progress.percent}%</span>
                    )}
                  </div>

                  {progress.percent !== undefined && (
                    <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-purple-500 to-blue-500"
                        animate={{ width: `${progress.percent}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                  )}

                  {progress.current !== undefined && progress.total !== undefined && (
                    <p className="text-xs text-gray-500">
                      სეგმენტი {progress.current} / {progress.total}
                    </p>
                  )}

                  {(progress.message || progress.text) && (
                    <p className="text-xs text-gray-400 truncate">
                      {progress.text ? `"${progress.text}"` : progress.message}
                    </p>
                  )}

                  {progress.stage === 'error' && (
                    <p className="text-xs text-red-400">{progress.message}</p>
                  )}
                </div>
              )}

              {/* Done — load button */}
              {pendingResult && (
                <div className="px-4 py-3">
                  <p className="text-xs text-gray-400 mb-3 truncate">
                    {pendingResult.metadata?.title || pendingResult.originalVideoId}
                  </p>
                  <button
                    onClick={loadPendingResult}
                    className="w-full bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium py-2 rounded-xl transition-all flex items-center justify-center gap-2"
                  >
                    <Play className="w-4 h-4" />
                    ნახვა
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
