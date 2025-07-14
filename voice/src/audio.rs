use std::collections::{HashMap, BTreeMap};
use std::time::Instant;
use ringbuf::{HeapRb, HeapProducer, HeapConsumer};

const SAMPLE_RATE: u32 = 48000;
const CHANNELS: u32 = 1;
const FRAME_SIZE: usize = 960; // 20ms at 48kHz
const OPUS_BITRATE: i32 = 32000;

#[derive(Clone, Debug)]
pub struct AudioPacket {
    pub seq: u32,
    pub timestamp: u64,
    pub data: Vec<f32>,
}

#[derive(Debug)]
pub struct JitterStats {
    pub loss_rate: f32,
    pub jitter_ms: f32,
}

pub struct AudioProcessor {
    // For now, we'll pass through the Opus data without re-encoding
    // The frontend already handles Opus encoding/decoding
    
    // Ring buffers for jitter handling - can't derive Debug
    #[allow(dead_code)]
    input_buffers: HashMap<String, HeapProducer<f32>>,
    #[allow(dead_code)]
    output_buffers: HashMap<String, HeapConsumer<f32>>,
    
    // Mixing state - we'll work with raw Opus packets
    participant_audio_raw: HashMap<String, Vec<u8>>, // Store raw Opus data
    participant_audio: HashMap<String, Vec<f32>>, // Decoded audio for mixing
    master_mix: Vec<f32>,
    
    // Audio quality monitoring
    packet_loss: HashMap<String, f32>,
    jitter_ms: HashMap<String, f32>,
    
    // Voice activity detection per participant
    vad_detectors: HashMap<String, VoiceActivityDetector>,
}

impl AudioProcessor {
    pub fn new() -> Self {
        Self {
            input_buffers: HashMap::new(),
            output_buffers: HashMap::new(),
            participant_audio_raw: HashMap::new(),
            participant_audio: HashMap::new(),
            master_mix: vec![0.0; FRAME_SIZE],
            packet_loss: HashMap::new(),
            jitter_ms: HashMap::new(),
            vad_detectors: HashMap::new(),
        }
    }
    
    pub fn has_participant(&self, participant_id: &str) -> bool {
        self.participant_audio_raw.contains_key(participant_id)
    }
    
    pub fn add_participant(&mut self, participant_id: String) -> Result<(), String> {
        // Create jitter buffer (100ms capacity)
        let buffer_size = (SAMPLE_RATE as usize * 100) / 1000;
        let (producer, consumer) = HeapRb::<f32>::new(buffer_size).split();
        
        self.input_buffers.insert(participant_id.clone(), producer);
        self.output_buffers.insert(participant_id.clone(), consumer);
        self.participant_audio_raw.insert(participant_id.clone(), Vec::new());
        self.participant_audio.insert(participant_id.clone(), vec![0.0; FRAME_SIZE]);
        self.vad_detectors.insert(participant_id.clone(), VoiceActivityDetector::new());
        
        Ok(())
    }
    
    pub fn remove_participant(&mut self, participant_id: &str) {
        self.input_buffers.remove(participant_id);
        self.output_buffers.remove(participant_id);
        self.participant_audio_raw.remove(participant_id);
        self.participant_audio.remove(participant_id);
        self.packet_loss.remove(participant_id);
        self.jitter_ms.remove(participant_id);
        self.vad_detectors.remove(participant_id);
    }
    
    pub fn decode_audio(&mut self, participant_id: &str, opus_data: &[u8]) -> Result<Vec<f32>, String> {
        // For now, we'll store the raw Opus data and return dummy decoded data
        // The actual decoding happens in the frontend
        if let Some(raw_audio) = self.participant_audio_raw.get_mut(participant_id) {
            *raw_audio = opus_data.to_vec();
        }
        
        // Return silence for now - in a real implementation, we'd decode here
        Ok(vec![0.0; FRAME_SIZE])
    }
    
    pub fn update_participant_audio(&mut self, participant_id: &str, audio: Vec<f32>) {
        // For now, just update the buffer
        if let Some(buffer) = self.participant_audio.get_mut(participant_id) {
            // Copy audio data, ensuring we don't exceed buffer size
            let copy_len = audio.len().min(buffer.len());
            buffer[..copy_len].copy_from_slice(&audio[..copy_len]);
        }
    }
    
    pub fn create_mix_minus_outputs(&mut self) -> HashMap<String, Vec<u8>> {
        let mut outputs = HashMap::new();
        
        println!("AudioProcessor: Total participants: {}", self.participant_audio_raw.len());
        for (id, data) in &self.participant_audio_raw {
            println!("  Participant {}: {} bytes of audio", id, data.len());
        }
        
        // Collect all non-empty audio data from participants
        let active_participants: Vec<(String, Vec<u8>)> = self.participant_audio_raw
            .iter()
            .filter(|(_, data)| !data.is_empty())
            .map(|(id, data)| (id.clone(), data.clone()))
            .collect();
        
        if active_participants.is_empty() {
            // No audio data to process
            return outputs;
        }
        
        // Create listener mix - combine all speaker audio
        // For now, we'll use the first active speaker's audio
        // In a full implementation, this would properly mix all speakers
        if let Some((_, first_audio)) = active_participants.first() {
            outputs.insert("__listener__".to_string(), first_audio.clone());
        }
        
        // Create mix-minus for each active participant
        // Each participant gets audio from others but not themselves
        if active_participants.len() == 1 {
            // Single participant - they don't get any audio back (no one else to hear)
            // Don't insert anything for them - this prevents sending empty data
        } else if active_participants.len() == 2 {
            // Two participants - each gets the other's audio
            outputs.insert(active_participants[0].0.clone(), active_participants[1].1.clone());
            outputs.insert(active_participants[1].0.clone(), active_participants[0].1.clone());
        } else {
            // Multiple participants - for now, simple round-robin
            // Each participant hears the next participant in the list
            for i in 0..active_participants.len() {
                let sender_id = &active_participants[i].0;
                let next_index = (i + 1) % active_participants.len();
                let audio_to_send = &active_participants[next_index].1;
                outputs.insert(sender_id.clone(), audio_to_send.clone());
            }
        }
        
        outputs
    }
    
    fn apply_compression(&self, buffer: &mut [f32]) {
        const THRESHOLD: f32 = 0.7;
        const RATIO: f32 = 4.0;
        
        for sample in buffer.iter_mut() {
            let abs_sample = sample.abs();
            if abs_sample > THRESHOLD {
                let over = abs_sample - THRESHOLD;
                let compressed = THRESHOLD + (over / RATIO);
                *sample = compressed * sample.signum();
            }
        }
    }
    
    fn apply_agc(&self, buffer: &mut [f32]) {
        // Simple AGC: normalize to target level
        const TARGET_RMS: f32 = 0.3;
        
        let rms = (buffer.iter().map(|s| s * s).sum::<f32>() / buffer.len() as f32).sqrt();
        if rms > 0.001 {
            let gain = (TARGET_RMS / rms).min(3.0).max(0.5); // Limit gain range
            for sample in buffer.iter_mut() {
                *sample *= gain;
            }
        }
    }
}

#[derive(Debug)]
pub struct VoiceActivityDetector {
    energy_threshold: f32,
    hangover_frames: usize,
    current_hangover: usize,
}

impl VoiceActivityDetector {
    pub fn new() -> Self {
        Self {
            energy_threshold: 0.01, // -40 dB
            hangover_frames: 8,     // 160ms
            current_hangover: 0,
        }
    }
    
    pub fn is_speech(&mut self, audio: &[f32]) -> bool {
        let energy: f32 = audio.iter().map(|s| s * s).sum::<f32>() / audio.len() as f32;
        
        if energy > self.energy_threshold {
            self.current_hangover = self.hangover_frames;
            true
        } else if self.current_hangover > 0 {
            self.current_hangover -= 1;
            true
        } else {
            false
        }
    }
}

#[derive(Debug)]
pub struct AdaptiveJitterBuffer {
    packets: BTreeMap<u32, AudioPacket>,
    target_delay_ms: u32,
    min_delay_ms: u32,
    max_delay_ms: u32,
    last_pop_time: Instant,
    stats: JitterStats,
    last_seq: u32,
    expected_seq: u32,
}

impl AdaptiveJitterBuffer {
    pub fn new() -> Self {
        Self {
            packets: BTreeMap::new(),
            target_delay_ms: 40,
            min_delay_ms: 20,
            max_delay_ms: 200,
            last_pop_time: Instant::now(),
            stats: JitterStats { loss_rate: 0.0, jitter_ms: 0.0 },
            last_seq: 0,
            expected_seq: 0,
        }
    }
    
    pub fn push(&mut self, seq: u32, timestamp: u64, data: Vec<f32>) {
        self.packets.insert(seq, AudioPacket { seq, timestamp, data });
        self.update_stats();
        self.adapt_delay();
    }
    
    pub fn pop(&mut self) -> Option<Vec<f32>> {
        let now = Instant::now();
        let target_seq = self.calculate_target_sequence(now);
        
        if let Some(packet) = self.packets.remove(&target_seq) {
            self.last_pop_time = now;
            self.last_seq = packet.seq;
            Some(packet.data)
        } else {
            // Generate comfort noise for missing packet
            Some(self.generate_comfort_noise())
        }
    }
    
    fn calculate_target_sequence(&self, _now: Instant) -> u32 {
        // Simple implementation: return the next expected sequence
        self.expected_seq
    }
    
    fn update_stats(&mut self) {
        // Calculate packet loss rate
        let total_expected = self.expected_seq - self.last_seq;
        if total_expected > 0 {
            let received = self.packets.len() as u32;
            self.stats.loss_rate = 1.0 - (received as f32 / total_expected as f32);
        }
    }
    
    fn adapt_delay(&mut self) {
        // Adjust delay based on network conditions
        if self.stats.loss_rate > 0.05 {
            self.target_delay_ms = (self.target_delay_ms + 10).min(self.max_delay_ms);
        } else if self.stats.loss_rate < 0.01 {
            self.target_delay_ms = (self.target_delay_ms - 5).max(self.min_delay_ms);
        }
    }
    
    fn generate_comfort_noise(&self) -> Vec<f32> {
        // Generate low-level white noise
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let mut noise = vec![0.0; FRAME_SIZE];
        for sample in noise.iter_mut() {
            *sample = rng.gen_range(-0.001..0.001);
        }
        noise
    }
}

// Manual Debug implementation for AudioProcessor
impl std::fmt::Debug for AudioProcessor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioProcessor")
            .field("participant_count", &self.participant_audio_raw.len())
            .field("master_mix_len", &self.master_mix.len())
            .finish()
    }
}