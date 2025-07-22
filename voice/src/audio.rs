use hyperware_app_common::hyperware_process_lib::println;
use opus::{Application, Channels, Decoder, Encoder};
use std::collections::HashMap;

const SAMPLE_RATE: u32 = 48000;
const FRAME_SIZE: usize = 960; // 20ms at 48kHz
const OPUS_BITRATE: i32 = 32000;

pub struct AudioProcessor {
    // Opus encoder/decoder for each participant
    decoders: HashMap<String, Decoder>,
    encoders: HashMap<String, Encoder>, // Per-participant encoders for better quality

    // Mixing state
    participant_audio_raw: HashMap<String, Vec<u8>>, // Store raw Opus data
    participant_audio: HashMap<String, Vec<f32>>,    // Decoded audio for mixing
    participant_has_sent_audio: HashMap<String, bool>, // Track if participant has ever sent audio
    participant_last_audio_time: HashMap<String, std::time::Instant>, // Track last audio time
    master_mix: Vec<f32>,

    // Voice activity detection per participant
    vad_detectors: HashMap<String, VoiceActivityDetector>,
}

impl AudioProcessor {
    pub fn new() -> Self {
        Self {
            decoders: HashMap::new(),
            encoders: HashMap::new(),
            participant_audio_raw: HashMap::new(),
            participant_audio: HashMap::new(),
            participant_has_sent_audio: HashMap::new(),
            participant_last_audio_time: HashMap::new(),
            master_mix: vec![0.0; FRAME_SIZE],
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

        // Create Opus encoder for this participant's mix-minus output
        match Encoder::new(SAMPLE_RATE, Channels::Mono, Application::Voip) {
            Ok(mut encoder) => {
                // Set bitrate for better quality
                if let Err(e) = encoder.set_bitrate(opus::Bitrate::Bits(OPUS_BITRATE)) {
                    println!("Failed to set Opus bitrate: {}", e);
                }
                self.encoders.insert(participant_id.clone(), encoder);
            }
            Err(e) => {
                return Err(format!("Failed to create Opus encoder: {}", e));
            }
        }

        self.participant_audio_raw
            .insert(participant_id.clone(), Vec::new());
        self.participant_audio
            .insert(participant_id.clone(), vec![0.0; FRAME_SIZE]);
        self.participant_has_sent_audio
            .insert(participant_id.clone(), false);
        self.participant_last_audio_time
            .insert(participant_id.clone(), std::time::Instant::now());
        self.vad_detectors
            .insert(participant_id.clone(), VoiceActivityDetector::new());

        Ok(())
    }

    pub fn remove_participant(&mut self, participant_id: &str) {
        self.decoders.remove(participant_id);
        self.encoders.remove(participant_id);
        self.participant_audio_raw.remove(participant_id);
        self.participant_audio.remove(participant_id);
        self.participant_has_sent_audio.remove(participant_id);
        self.participant_last_audio_time.remove(participant_id);
        self.vad_detectors.remove(participant_id);
    }

    pub fn decode_audio(
        &mut self,
        participant_id: &str,
        opus_data: &[u8],
    ) -> Result<Vec<f32>, String> {
        // Check if we received Ogg-wrapped data instead of raw Opus
        if opus_data.len() >= 4 && &opus_data[0..4] == b"OggS" {
            println!(
                "ERROR: Received Ogg-wrapped data from {}, expected raw Opus frames!",
                participant_id
            );
            println!(
                "First 16 bytes: {:?}",
                &opus_data[..opus_data.len().min(16)]
            );
            return Err("Ogg container not supported - expected raw Opus frames".to_string());
        }

        // Log packet info for debugging
        if opus_data.len() > 0 {
            println!(
                "AudioProcessor: Received {} bytes from {}, first byte: {}",
                opus_data.len(),
                participant_id,
                opus_data[0]
            );
        }

        // Mark that this participant has sent audio
        if let Some(has_sent) = self.participant_has_sent_audio.get_mut(participant_id) {
            *has_sent = true;
        }
        if let Some(last_time) = self.participant_last_audio_time.get_mut(participant_id) {
            *last_time = std::time::Instant::now();
        }

        // Store the original data as-is for later mix-minus processing
        if let Some(raw_audio) = self.participant_audio_raw.get_mut(participant_id) {
            *raw_audio = opus_data.to_vec();
        }

        // We now receive raw Opus frames directly

        // Raw data already stored above

        // Decode using the participant's decoder
        if let Some(decoder) = self.decoders.get_mut(participant_id) {
            // Prepare output buffer for decoded samples
            let mut output = vec![0i16; FRAME_SIZE];

            match decoder.decode(opus_data, &mut output, false) {
                Ok(samples_decoded) => {
                    // Convert i16 samples to f32
                    let mut float_output = Vec::with_capacity(samples_decoded);
                    let mut max_sample = 0.0f32;
                    for i in 0..samples_decoded {
                        let sample = output[i] as f32 / 32768.0;
                        max_sample = max_sample.max(sample.abs());
                        float_output.push(sample);
                    }

                    println!(
                        "AudioProcessor: Decoded {} samples for {}, max amplitude: {}",
                        samples_decoded, participant_id, max_sample
                    );

                    // Pad with zeros if needed
                    while float_output.len() < FRAME_SIZE {
                        float_output.push(0.0);
                    }

                    Ok(float_output)
                }
                Err(e) => {
                    println!(
                        "Opus decode error for participant {}: {}",
                        participant_id, e
                    );
                    // Return error instead of silence to avoid hiding issues
                    Err(format!("Opus decode failed: {}", e))
                }
            }
        } else {
            println!(
                "AudioProcessor: No decoder found for participant {}",
                participant_id
            );
            Err(format!(
                "No decoder found for participant {}",
                participant_id
            ))
        }
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

        // Get all registered participants (not just those with recent audio)
        let all_participants: Vec<String> = self.participant_audio.keys().cloned().collect();

        // Get participants who currently have audio data to contribute to the mix
        let active_participants: Vec<(String, Vec<u8>, Vec<f32>)> = self
            .participant_audio_raw
            .iter()
            .filter(|(_, data)| !data.is_empty())
            .filter_map(|(id, raw_data)| {
                self.participant_audio
                    .get(id)
                    .map(|decoded_audio| (id.clone(), raw_data.clone(), decoded_audio.clone()))
            })
            .collect();

        println!(
            "AudioProcessor: Creating mixes for {} participants, {} have active audio",
            all_participants.len(),
            active_participants.len()
        );

        if active_participants.is_empty() {
            // No audio data to process
            println!("AudioProcessor: No active audio data to process");
            return outputs;
        }

        // Skip creating a shared listener mix - we'll create individual mixes for each participant

        // Create personalized mix for each registered participant
        for target_id in &all_participants {
            // Skip if there's no audio from anyone
            if active_participants.is_empty() {
                continue;
            }

            // Check if this participant has sent audio (i.e., is an active speaker)
            let is_active_speaker = active_participants.iter().any(|(id, _, _)| id == target_id);

            let mut mix = vec![0.0f32; FRAME_SIZE];
            let mut has_audio = false;

            if is_active_speaker {
                // For active speakers: create mix-minus (exclude their own audio)
                for (participant_id, _, decoded_audio) in &active_participants {
                    if participant_id != target_id {
                        has_audio = true;
                        for i in 0..FRAME_SIZE.min(decoded_audio.len()) {
                            mix[i] += decoded_audio[i];
                        }
                    }
                }
            } else {
                // For listeners/chatters: create full mix (include all audio)
                for (_, _, decoded_audio) in &active_participants {
                    has_audio = true;
                    for i in 0..FRAME_SIZE.min(decoded_audio.len()) {
                        mix[i] += decoded_audio[i];
                    }
                }
            }

            if has_audio {
                // Check if mix has actual audio
                let max_sample = mix.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
                println!(
                    "AudioProcessor: Mix for {} has max amplitude: {}, is_speaker: {}",
                    target_id, max_sample, is_active_speaker
                );

                // Apply compression
                Self::apply_compression_static(&mut mix);

                // Convert to i16 and encode
                let i16_buffer: Vec<i16> = mix
                    .iter()
                    .map(|&sample| (sample.max(-1.0).min(1.0) * 32767.0) as i16)
                    .collect();

                let mut opus_output = vec![0u8; 4000];
                if let Some(encoder) = self.encoders.get_mut(target_id) {
                    match encoder.encode(&i16_buffer, &mut opus_output) {
                        Ok(bytes_written) => {
                            opus_output.truncate(bytes_written);
                            println!(
                                "AudioProcessor: Encoded {} bytes for {}",
                                bytes_written, target_id
                            );

                            // Output raw Opus frames directly (no Ogg wrapping)
                            outputs.insert(target_id.clone(), opus_output);
                        }
                        Err(e) => {
                            println!("Failed to encode mix for {}: {}", target_id, e);
                        }
                    }
                } else {
                    println!("No encoder found for participant {}", target_id);
                }
            }
        }

        // Clear the raw audio data after creating mixes to avoid reprocessing
        for (participant_id, _, _) in &active_participants {
            if let Some(raw_audio) = self.participant_audio_raw.get_mut(participant_id) {
                raw_audio.clear();
            }
        }

        outputs
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
}

#[derive(Debug)]
pub struct VoiceActivityDetector {}

impl VoiceActivityDetector {
    pub fn new() -> Self {
        Self {}
    }
}

// Manual Debug implementation for AudioProcessor
impl std::fmt::Debug for AudioProcessor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioProcessor")
            .field("participant_count", &self.participant_audio_raw.len())
            .field("decoders_count", &self.decoders.len())
            .field("encoders_count", &self.encoders.len())
            .field(
                "participants_sent_audio",
                &self.participant_has_sent_audio.len(),
            )
            .field("master_mix_len", &self.master_mix.len())
            .finish()
    }
}
