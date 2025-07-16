use std::collections::{HashMap, BTreeMap};
use std::time::Instant;
use ringbuf::{HeapRb, HeapProducer, HeapConsumer};
use opus::{Decoder, Encoder, Channels, Application};

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
    // Opus encoder/decoder for each participant
    decoders: HashMap<String, Decoder>,
    encoder: Option<Encoder>,
    
    // Ring buffers for jitter handling - can't derive Debug
    #[allow(dead_code)]
    input_buffers: HashMap<String, HeapProducer<f32>>,
    #[allow(dead_code)]
    output_buffers: HashMap<String, HeapConsumer<f32>>,
    
    // Mixing state
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
        // Create a shared encoder for mix outputs
        let encoder = match Encoder::new(SAMPLE_RATE, Channels::Mono, Application::Voip) {
            Ok(enc) => Some(enc),
            Err(e) => {
                eprintln!("Failed to create Opus encoder: {}", e);
                None
            }
        };
        
        Self {
            decoders: HashMap::new(),
            encoder,
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
        // Create Opus decoder for this participant
        match Decoder::new(SAMPLE_RATE, Channels::Mono) {
            Ok(decoder) => {
                self.decoders.insert(participant_id.clone(), decoder);
            }
            Err(e) => {
                return Err(format!("Failed to create Opus decoder: {}", e));
            }
        }
        
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
        self.decoders.remove(participant_id);
        self.input_buffers.remove(participant_id);
        self.output_buffers.remove(participant_id);
        self.participant_audio_raw.remove(participant_id);
        self.participant_audio.remove(participant_id);
        self.packet_loss.remove(participant_id);
        self.jitter_ms.remove(participant_id);
        self.vad_detectors.remove(participant_id);
    }
    
    pub fn decode_audio(&mut self, participant_id: &str, opus_data: &[u8]) -> Result<Vec<f32>, String> {
        println!("AudioProcessor: decode_audio for {} with {} bytes", participant_id, opus_data.len());
        
        // Check if this is Ogg-wrapped Opus data
        if opus_data.len() >= 4 && &opus_data[0..4] == b"OggS" {
            println!("AudioProcessor: Received Ogg-wrapped Opus data, extracting frames...");
            return self.decode_ogg_opus(participant_id, opus_data);
        }
        
        // Check for and strip header if present
        let (actual_opus_data, _is_simple_format) = if opus_data.len() >= 4 && opus_data[0] == 0x4F {
            if opus_data[1] == 0x50 {
                // 'OP' - Simple PCM format - reject it, we only use real Opus
                return Err("Simple PCM format not supported - use real Opus encoding".to_string());
            } else if opus_data[1] == 0x52 {
                // 'OR' - Real Opus format
                let data_length = ((opus_data[2] as usize) << 8) | (opus_data[3] as usize);
                println!("AudioProcessor: Found Opus header, data length: {}", data_length);
                if opus_data.len() >= 4 + data_length {
                    (&opus_data[4..4 + data_length], false)
                } else {
                    println!("AudioProcessor: Invalid header, using all data");
                    (opus_data, false)
                }
            } else {
                println!("AudioProcessor: Unknown header format: {:02X} {:02X}", opus_data[0], opus_data[1]);
                (opus_data, false)
            }
        } else {
            println!("AudioProcessor: No header found, using raw data");
            (opus_data, false)
        };
        
        // Store the raw Opus data (without header)
        if let Some(raw_audio) = self.participant_audio_raw.get_mut(participant_id) {
            *raw_audio = actual_opus_data.to_vec();
            println!("AudioProcessor: Stored {} bytes of raw audio for {}", actual_opus_data.len(), participant_id);
        } else {
            println!("AudioProcessor: No raw audio buffer for {}", participant_id);
        }
        
        // Decode using the participant's decoder
        if let Some(decoder) = self.decoders.get_mut(participant_id) {
            // Prepare output buffer for decoded samples
            let mut output = vec![0i16; FRAME_SIZE];
            
            println!("AudioProcessor: Attempting to decode {} bytes of Opus data", actual_opus_data.len());
            match decoder.decode(actual_opus_data, &mut output, false) {
                Ok(samples_decoded) => {
                    println!("AudioProcessor: Decoded {} samples", samples_decoded);
                    
                    // Convert i16 samples to f32
                    let mut float_output = Vec::with_capacity(samples_decoded);
                    let mut max_sample = 0.0f32;
                    for i in 0..samples_decoded {
                        let sample = output[i] as f32 / 32768.0;
                        max_sample = max_sample.max(sample.abs());
                        float_output.push(sample);
                    }
                    
                    println!("AudioProcessor: Max decoded sample amplitude: {}", max_sample);
                    
                    // Pad with zeros if needed
                    while float_output.len() < FRAME_SIZE {
                        float_output.push(0.0);
                    }
                    
                    Ok(float_output)
                }
                Err(e) => {
                    eprintln!("Opus decode error for participant {}: {}", participant_id, e);
                    // Return error instead of silence to avoid hiding issues
                    Err(format!("Opus decode failed: {}", e))
                }
            }
        } else {
            println!("AudioProcessor: No decoder found for participant {}", participant_id);
            Err(format!("No decoder found for participant {}", participant_id))
        }
    }
    
    fn decode_ogg_opus(&mut self, participant_id: &str, ogg_data: &[u8]) -> Result<Vec<f32>, String> {
        println!("AudioProcessor: Parsing Ogg container, {} bytes", ogg_data.len());
        
        // Simple Ogg page parser to extract Opus packets
        // This is a minimal implementation - in production you'd use a proper Ogg demuxer
        
        let mut offset = 0;
        let mut all_audio = Vec::new();
        
        while offset + 27 < ogg_data.len() {
            // Check for "OggS" magic
            if &ogg_data[offset..offset+4] != b"OggS" {
                break;
            }
            
            // Skip to segment table
            let num_segments = ogg_data[offset + 26] as usize;
            if offset + 27 + num_segments > ogg_data.len() {
                break;
            }
            
            // Calculate total page payload size
            let mut payload_size = 0;
            for i in 0..num_segments {
                payload_size += ogg_data[offset + 27 + i] as usize;
            }
            
            let payload_start = offset + 27 + num_segments;
            if payload_start + payload_size > ogg_data.len() {
                break;
            }
            
            // Extract payload
            let payload = &ogg_data[payload_start..payload_start + payload_size];
            
            // Skip Opus header pages (they start with "OpusHead" or "OpusTags")
            if payload.len() >= 8 {
                if &payload[0..8] == b"OpusHead" || &payload[0..8] == b"OpusTags" {
                    println!("AudioProcessor: Skipping Opus header page");
                    offset = payload_start + payload_size;
                    continue;
                }
            }
            
            // This should be an Opus audio packet
            if !payload.is_empty() {
                println!("AudioProcessor: Found Opus packet, {} bytes", payload.len());
                
                // Decode this Opus packet
                if let Some(decoder) = self.decoders.get_mut(participant_id) {
                    let mut output = vec![0i16; FRAME_SIZE * 2]; // Extra space for safety
                    
                    match decoder.decode(payload, &mut output, false) {
                        Ok(samples_decoded) => {
                            println!("AudioProcessor: Decoded {} samples from Ogg packet", samples_decoded);
                            
                            // Convert to f32 and append
                            for i in 0..samples_decoded {
                                let sample = output[i] as f32 / 32768.0;
                                all_audio.push(sample);
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to decode Opus packet from Ogg: {}", e);
                            // Continue with next packet instead of failing completely
                        }
                    }
                }
            }
            
            offset = payload_start + payload_size;
        }
        
        // Store raw data for later use
        if let Some(raw_audio) = self.participant_audio_raw.get_mut(participant_id) {
            // For now, store the original Ogg data
            *raw_audio = ogg_data.to_vec();
        }
        
        if all_audio.is_empty() {
            println!("AudioProcessor: No audio decoded from Ogg container");
            // Try to decode as raw Opus if Ogg parsing failed
            println!("AudioProcessor: Attempting to decode as raw Opus...");
            if let Some(decoder) = self.decoders.get_mut(participant_id) {
                let mut output = vec![0i16; FRAME_SIZE];
                match decoder.decode(ogg_data, &mut output, false) {
                    Ok(samples) => {
                        let mut float_output = Vec::with_capacity(samples);
                        for i in 0..samples {
                            float_output.push(output[i] as f32 / 32768.0);
                        }
                        while float_output.len() < FRAME_SIZE {
                            float_output.push(0.0);
                        }
                        return Ok(float_output);
                    }
                    Err(_) => {
                        return Ok(vec![0.0; FRAME_SIZE]);
                    }
                }
            }
            return Ok(vec![0.0; FRAME_SIZE]);
        }
        
        // Take only the first frame worth of samples
        let mut result = vec![0.0; FRAME_SIZE];
        let copy_len = all_audio.len().min(FRAME_SIZE);
        result[..copy_len].copy_from_slice(&all_audio[..copy_len]);
        
        println!("AudioProcessor: Returning {} samples from Ogg decode", result.len());
        Ok(result)
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
        println!("AudioProcessor: Participant audio buffers: {:?}", 
            self.participant_audio.iter().map(|(id, audio)| {
                let non_zero = audio.iter().filter(|&&s| s.abs() > 0.0001).count();
                (id.clone(), audio.len(), non_zero)
            }).collect::<Vec<_>>()
        );
        
        // First check who has raw audio data
        let participants_with_raw_audio: Vec<(String, Vec<u8>)> = self.participant_audio_raw
            .iter()
            .filter(|(_, data)| !data.is_empty())
            .map(|(id, data)| (id.clone(), data.clone()))
            .collect();
        
        println!("AudioProcessor: Participants with raw audio: {:?}", 
            participants_with_raw_audio.iter().map(|(id, data)| (id, data.len())).collect::<Vec<_>>()
        );
        
        // Now collect decoded audio for those who have raw audio
        let active_participants: Vec<(String, Vec<f32>)> = participants_with_raw_audio
            .iter()
            .filter_map(|(id, _)| {
                self.participant_audio.get(id).map(|audio| (id.clone(), audio.clone()))
            })
            .collect();
        
        if active_participants.is_empty() {
            // No audio data to process
            return outputs;
        }
        
        // If we don't have an encoder, return empty
        if self.encoder.is_none() {
            eprintln!("No Opus encoder available");
            return outputs;
        }
        
        // Create listener mix - combine all speaker audio
        if !active_participants.is_empty() {
            let mut listener_mix = vec![0.0f32; FRAME_SIZE];
            
            // Mix all active participants
            for (_, audio) in &active_participants {
                for i in 0..FRAME_SIZE.min(audio.len()) {
                    listener_mix[i] += audio[i];
                }
            }
            
            // Apply compression to prevent clipping
            Self::apply_compression_static(&mut listener_mix);
            
            // Convert to i16 and encode
            let i16_buffer: Vec<i16> = listener_mix.iter()
                .map(|&sample| (sample.max(-1.0).min(1.0) * 32767.0) as i16)
                .collect();
            
            let mut opus_output = vec![0u8; 4000]; // Max Opus frame size
            if let Some(encoder) = self.encoder.as_mut() {
                match encoder.encode(&i16_buffer, &mut opus_output) {
                    Ok(bytes_written) => {
                        opus_output.truncate(bytes_written);
                        // Add header for frontend
                        let with_header = Self::add_opus_header(&opus_output);
                        outputs.insert("__listener__".to_string(), with_header);
                    }
                    Err(e) => {
                        eprintln!("Failed to encode listener mix: {}", e);
                    }
                }
            }
        }
        
        // Create mix-minus for each active participant
        for (target_idx, (target_id, _)) in active_participants.iter().enumerate() {
            if active_participants.len() == 1 {
                // Single participant - no audio to send back
                continue;
            }
            
            let mut mix_minus = vec![0.0f32; FRAME_SIZE];
            let mut has_audio = false;
            
            // Mix all participants except the target
            for (idx, (_, audio)) in active_participants.iter().enumerate() {
                if idx != target_idx {
                    has_audio = true;
                    for i in 0..FRAME_SIZE.min(audio.len()) {
                        mix_minus[i] += audio[i];
                    }
                }
            }
            
            if has_audio {
                // Apply compression
                Self::apply_compression_static(&mut mix_minus);
                
                // Convert to i16 and encode
                let i16_buffer: Vec<i16> = mix_minus.iter()
                    .map(|&sample| (sample.max(-1.0).min(1.0) * 32767.0) as i16)
                    .collect();
                
                let mut opus_output = vec![0u8; 4000];
                if let Some(encoder) = self.encoder.as_mut() {
                    match encoder.encode(&i16_buffer, &mut opus_output) {
                        Ok(bytes_written) => {
                            opus_output.truncate(bytes_written);
                            // Add header for frontend
                            let with_header = Self::add_opus_header(&opus_output);
                            outputs.insert(target_id.clone(), with_header);
                        }
                        Err(e) => {
                            eprintln!("Failed to encode mix-minus for {}: {}", target_id, e);
                        }
                    }
                }
            }
        }
        
        outputs
    }
    
    fn add_opus_header(opus_data: &[u8]) -> Vec<u8> {
        // For Ogg-wrapped data, just pass it through without adding custom headers
        if opus_data.len() >= 4 && &opus_data[0..4] == b"OggS" {
            return opus_data.to_vec();
        }
        
        let mut with_header = Vec::with_capacity(opus_data.len() + 4);
        with_header.push(0x4F); // 'O'
        with_header.push(0x52); // 'R' for opus-recorder
        with_header.push((opus_data.len() >> 8) as u8);
        with_header.push(opus_data.len() as u8);
        with_header.extend_from_slice(opus_data);
        with_header
    }
    
    fn decode_simple_pcm(&mut self, participant_id: &str, pcm_data: &[u8], original_size: usize) -> Result<Vec<f32>, String> {
        println!("AudioProcessor: Decoding simple PCM format, {} bytes to {} samples", pcm_data.len(), original_size);
        
        // Store the raw data
        if let Some(raw_audio) = self.participant_audio_raw.get_mut(participant_id) {
            // For simple format, store the original PCM data with header for re-encoding
            let mut with_header = Vec::with_capacity(pcm_data.len() + 4);
            with_header.push(0x4F); // 'O'
            with_header.push(0x50); // 'P'
            with_header.push((original_size >> 8) as u8);
            with_header.push(original_size as u8);
            with_header.extend_from_slice(pcm_data);
            *raw_audio = with_header;
        }
        
        // Decompress the simple format
        const COMPRESSION_RATIO: usize = 10;
        let mut float_output = vec![0.0f32; original_size];
        let compressed_samples = pcm_data.len() / 2; // 2 bytes per i16
        
        if compressed_samples > 0 {
            for i in 0..compressed_samples {
                let sample_i16 = (pcm_data[i * 2 + 1] as i16) << 8 | (pcm_data[i * 2] as i16);
                let sample_f32 = sample_i16 as f32 / 32768.0;
                
                // Fill decompressed samples
                let start_idx = i * COMPRESSION_RATIO;
                let end_idx = ((i + 1) * COMPRESSION_RATIO).min(original_size);
                
                // Simple interpolation if we have next sample
                let next_sample = if i + 1 < compressed_samples {
                    let next_i16 = (pcm_data[(i + 1) * 2 + 1] as i16) << 8 | (pcm_data[(i + 1) * 2] as i16);
                    next_i16 as f32 / 32768.0
                } else {
                    sample_f32
                };
                
                for j in start_idx..end_idx {
                    let t = (j - start_idx) as f32 / COMPRESSION_RATIO as f32;
                    float_output[j] = sample_f32 * (1.0 - t) + next_sample * t;
                }
            }
        }
        
        Ok(float_output)
    }
    
    fn apply_compression(&self, buffer: &mut [f32]) {
        Self::apply_compression_static(buffer);
    }
    
    fn apply_compression_static(buffer: &mut [f32]) {
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
            .field("decoders_count", &self.decoders.len())
            .field("encoder_available", &self.encoder.is_some())
            .field("master_mix_len", &self.master_mix.len())
            .finish()
    }
}