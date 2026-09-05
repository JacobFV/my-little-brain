import { useEffect, useState } from 'react';
import { Brain, Heart, Sparkles } from 'lucide-react';
export function Startup({ reducedMotion }: { reducedMotion: boolean }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), reducedMotion ? 150 : 1700);
    return () => clearTimeout(timer);
  }, [reducedMotion]);
  if (!visible) return null;
  return (
    <div
      className={`startup ${reducedMotion ? 'still' : ''}`}
      role="status"
      aria-label="Your little brain is waking up"
    >
      <div className="startup-character">
        <Heart className="startup-heart" size={22} />
        <div className="startup-brain">
          <Brain size={68} strokeWidth={1.3} />
          <span className="startup-eyes">
            <i />
            <i />
          </span>
        </div>
        <Sparkles className="startup-spark" size={24} />
      </div>
      <p>A little hello to your mind.</p>
    </div>
  );
}
