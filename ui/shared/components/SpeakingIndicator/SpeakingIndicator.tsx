import React, { useEffect, useRef } from 'react';
import './SpeakingIndicator.css';

interface SpeakingIndicatorProps {
  participantId: string;
  isSpeaking?: boolean;
  audioLevel?: number;
}

export const SpeakingIndicator: React.FC<SpeakingIndicatorProps> = ({ 
  participantId, 
  isSpeaking = false,
  audioLevel = 0 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Draw volume indicator based on audioLevel prop
      if (audioLevel > 0.05 && isSpeaking) { // Threshold for speaking
        ctx.fillStyle = '#4CAF50';
        const barHeight = audioLevel * canvas.height;
        ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);
      }
      
      animationRef.current = requestAnimationFrame(draw);
    };
    
    draw();
    
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [audioLevel, isSpeaking]);
  
  return (
    <div className={`speaking-indicator ${isSpeaking ? 'speaking' : ''}`}>
      <canvas 
        ref={canvasRef} 
        width={20} 
        height={20}
        className="audio-visualizer"
      />
    </div>
  );
};