use hyperprocess_macro::hyperprocess;
use hyperware_process_lib::http::server::{send_ws_push, WsMessageType};
use hyperware_process_lib::{kiprintln, LazyLoadBlob, our};
use hyperware_app_common::source;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use rand::seq::SliceRandom;
use std::sync::{Arc, Mutex};
use base64::{Engine as _, engine::general_purpose};

mod audio;
use audio::AudioProcessor;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Role {
    Listener,
    Chatter,
    Speaker,
    Admin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionType {
    Node(String),
    Browser,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCallReq {
    pub default_role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallInfo {
    pub id: String,
    pub created_at: u64,
    pub participant_count: u32,
    pub default_role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinCallReq {
    pub call_id: String,
    pub node_auth: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinInfo {
    pub call_id: String,
    pub participant_id: String,
    pub role: Role,
    pub auth_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallState {
    pub call_info: CallInfo,
    pub participants: Vec<ParticipantInfo>,
    pub chat_history: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantInfo {
    pub id: String,
    pub display_name: String,
    pub role: Role,
    pub is_muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaveCallReq {
    pub call_id: String,
    pub participant_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoleReq {
    pub call_id: String,
    pub requester_id: String,
    pub target_id: String,
    pub new_role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeHandshakeReq {
    pub call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeHandshakeResp {
    pub auth_token: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WsClientMessage {
    #[serde(rename_all = "camelCase")]
    JoinCall { call_id: String, auth_token: Option<String>, display_name: Option<String> },
    Chat(String),
    Mute(bool),
    #[serde(rename_all = "camelCase")]
    AudioData { data: String, sample_rate: u32, channels: u32, sequence: Option<u32>, timestamp: Option<u64> },
    Heartbeat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsChatMessage {
    pub message: ChatMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsParticipantJoined {
    pub participant: ParticipantInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsRoleUpdate {
    pub participant_id: String,
    pub new_role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsParticipantMuted {
    pub participant_id: String,
    pub is_muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsAudioData {
    pub participant_id: String,
    pub data: String,
    pub sequence: Option<u32>,
    pub timestamp: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WsServerMessage {
    #[serde(rename_all = "camelCase")]
    JoinSuccess { participant_id: String, role: Role, participants: Vec<ParticipantInfo>, chat_history: Vec<ChatMessage>, auth_token: String, host_id: Option<String> },
    Chat(WsChatMessage),
    ParticipantJoined(WsParticipantJoined),
    #[serde(rename_all = "camelCase")]
    ParticipantLeft { participant_id: String },
    RoleUpdated(WsRoleUpdate),
    ParticipantMuted(WsParticipantMuted),
    AudioData(WsAudioData),
    Error(String),
    CallEnded,
}


#[derive(Default, Debug, Clone, Serialize, Deserialize)]
struct VoiceState {
    calls: HashMap<String, Call>,
    connections: HashMap<u32, String>, // channel_id -> participant_id
    participant_channels: HashMap<String, u32>, // participant_id -> channel_id
    call_channels: HashMap<String, HashSet<u32>>, // call_id -> set of channel_ids
    word_dictionary: Vec<String>,
    used_pleb_names: HashMap<String, Vec<String>>,
    node_auth_tokens: HashMap<String, String>, // auth_token -> node_id
    #[serde(skip)]
    audio_processors: HashMap<String, Arc<Mutex<AudioProcessor>>>, // Per call audio processor
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Call {
    id: String,
    participants: HashMap<String, Participant>,
    chat_history: Vec<ChatMessage>,
    created_at: u64,
    default_role: Role,
    creator_id: Option<String>,
    host_id: Option<String>, // The participant who mixes audio
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Participant {
    id: String,
    display_name: String,
    role: Role,
    connection_type: ConnectionType,
    is_muted: bool,
}

#[hyperprocess(
    name = "voice",
    ui = Some(HttpBindingConfig::default()),
    endpoints = vec![
        Binding::Http {
            path: "/api",
            config: HttpBindingConfig::default(),
        },
        Binding::Ws {
            path: "/ws",
            config: WsBindingConfig::default().authenticated(false),
        },
    ],
    save_config = hyperware_app_common::SaveOptions::Never,
    wit_world = "voice-sys-v0",
)]
impl VoiceState {
    #[init]
    async fn init(&mut self) {
        self.word_dictionary = vec![
            "apple", "banana", "cherry", "dog", "elephant", "forest",
            "galaxy", "hello", "island", "jungle", "kitten", "lemon",
            "mountain", "nebula", "ocean", "planet", "quantum", "rainbow",
            "sunset", "thunder", "universe", "volcano", "waterfall", "xylophone",
            "yellow", "zebra", "acoustic", "bicycle", "chocolate", "diamond",
            "emerald", "fountain", "guitar", "helicopter", "illusion", "jasmine"
        ].into_iter().map(String::from).collect();
    }

    #[http(method = "POST")]
    async fn create_call(&mut self, request: CreateCallReq) -> Result<CallInfo, String> {
        let call_id = generate_call_id(&self.word_dictionary);

        let call = Call {
            id: call_id.clone(),
            participants: HashMap::new(),
            chat_history: Vec::new(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs(),
            default_role: request.default_role.clone(),
            creator_id: None, // Will be set when creator joins
            host_id: None, // Will be set when first participant joins
        };

        let call_info = CallInfo {
            id: call_id.clone(),
            created_at: call.created_at,
            participant_count: 0,
            default_role: call.default_role.clone(),
        };

        self.calls.insert(call_id.clone(), call);
        self.used_pleb_names.insert(call_id.clone(), Vec::new());

        // Serve the in-call UI at /call/<call-id>
        let call_path = format!("/call/{}", call_id);
        if let Err(e) = hyperware_app_common::get_server().unwrap().serve_ui(
            "ui-call",
            vec![&call_path],
            HttpBindingConfig::default().authenticated(false)
        ) {
            kiprintln!("Failed to serve UI for call {}: {:?}", call_id, e);
        }

        Ok(call_info)
    }


    #[http(method = "POST")]
    async fn get_call_info(&mut self, call_id: String) -> Result<CallState, String> {
        let call = self.calls.get(&call_id)
            .ok_or_else(|| "Call not found".to_string())?;

        let participants: Vec<ParticipantInfo> = call.participants.values()
            .map(|p| ParticipantInfo {
                id: p.id.clone(),
                display_name: p.display_name.clone(),
                role: p.role.clone(),
                is_muted: p.is_muted,
            })
            .collect();

        let call_state = CallState {
            call_info: CallInfo {
                id: call.id.clone(),
                created_at: call.created_at,
                participant_count: call.participants.len() as u32,
                default_role: call.default_role.clone(),
            },
            participants,
            chat_history: call.chat_history.clone(),
        };

        Ok(call_state)
    }

    #[http(method = "POST")]
    async fn leave_call(&mut self, request: LeaveCallReq) -> Result<(), String> {
        // First check if call exists
        if !self.calls.contains_key(&request.call_id) {
            return Err("Call not found".to_string());
        }

        // Get host_id before any mutations
        let host_id = self.calls.get(&request.call_id)
            .and_then(|call| call.host_id.clone());

        // Check if this is the host leaving
        let is_host_leaving = host_id.as_ref() == Some(&request.participant_id);

        // If host is leaving, end call immediately
        if is_host_leaving {
            kiprintln!("Host {} is leaving call {}, ending call", request.participant_id, request.call_id);

            // Disconnect all WebSocket connections first
            disconnect_all_call_channels(&self, &request.call_id);

            // Unserve the UI
            let call_path = format!("/call/{}", request.call_id);
            if let Err(e) = hyperware_app_common::get_server().unwrap().unserve_ui("ui-call", vec![&call_path]) {
                kiprintln!("Failed to unserve UI for call {}: {:?}", request.call_id, e);
            }

            // Clean up connection mappings for all participants
            if let Some(call) = self.calls.get(&request.call_id) {
                for participant_id in call.participants.keys() {
                    if let Some(channel_id) = self.participant_channels.remove(participant_id) {
                        self.connections.remove(&channel_id);
                    }
                }
            }

            // Clean up all state
            self.calls.remove(&request.call_id);
            self.used_pleb_names.remove(&request.call_id);
            self.call_channels.remove(&request.call_id);
            self.audio_processors.remove(&request.call_id);
        } else {
            // Regular participant leaving
            if let Some(call) = self.calls.get_mut(&request.call_id) {
                call.participants.remove(&request.participant_id);

                // Check if call is now empty
                // Notify remaining participants
                let notification = WsServerMessage::ParticipantLeft { participant_id: request.participant_id.clone() };
                broadcast_to_call(&self, &request.call_id, notification);
            }

            // Clean up connection mappings
            if let Some(channel_id) = self.participant_channels.remove(&request.participant_id) {
                self.connections.remove(&channel_id);
                if let Some(channels) = self.call_channels.get_mut(&request.call_id) {
                    channels.remove(&channel_id);
                }
            }
        }

        Ok(())
    }

    #[http(method = "POST")]
    async fn update_role(&mut self, request: UpdateRoleReq) -> Result<(), String> {
        let call = self.calls.get_mut(&request.call_id)
            .ok_or_else(|| "Call not found".to_string())?;

        let requester = call.participants.get(&request.requester_id)
            .ok_or_else(|| "Requester not found".to_string())?;

        if !matches!(requester.role, Role::Admin) {
            return Err("Unauthorized: Only admins can update roles".to_string());
        }

        let participant = call.participants.get_mut(&request.target_id)
            .ok_or_else(|| "Target participant not found".to_string())?;

        participant.role = request.new_role.clone();

        Ok(())
    }




    #[http(method = "POST", path = "/start-node-handshake")]
    async fn start_node_handshake(&mut self, url: String) -> Result<String, String> {
        // Import the generated RPC function
        use hyperware_process_lib::{Address, Request};
        use hyperware_app_common::send;
        use serde_json::json;

        // Extract call ID from the URL
        // Expected format: "https://<host>/voice:voice:sys/call/<call-id>"
        let call_id = url
            .split("/call/")
            .nth(1)
            .ok_or_else(|| "Invalid URL format: no call ID found".to_string())?
            .split('?')  // Remove any query parameters
            .next()
            .unwrap_or("")
            .to_string();

        // Extract host node from the call ID
        // Call ID format: "<host-node>-word1-word2-word3"
        let host_node = call_id
            .split('-')
            .next()
            .ok_or_else(|| "Invalid call ID format: no host node found".to_string())?;

        // Build the target address for the host node
        let target = Address::new(host_node, ("voice", "voice", "sys"));

        // Create the handshake request using our properly serialized type
        let handshake_req = NodeHandshakeReq {
            call_id: call_id.clone(),
        };

        // Send the node handshake request with proper serialization
        let body = json!({"NodeHandshake": handshake_req});
        let body = serde_json::to_vec(&body).unwrap();
        let request = Request::to(&target).body(body);

        match send::<Result<NodeHandshakeResp, String>>(request).await {
            Ok(Ok(handshake_resp)) => {
                // Redirect to the URL provided by the host, including the auth token
                let redirect_url = format!("{}?auth={}", url, handshake_resp.auth_token);
                Ok(redirect_url)
            }
            Ok(Err(e)) => Err(format!("Handshake failed: {}", e)),
            Err(e) => Err(format!("Failed to send handshake request: {:?}", e)),
        }
    }

    #[local]
    #[remote]
    async fn node_handshake(&mut self, request: NodeHandshakeReq) -> Result<NodeHandshakeResp, String> {
        // Check if call exists
        if !self.calls.contains_key(&request.call_id) {
            return Err("Call not found".to_string());
        }

        // Generate auth token for this node
        let auth_token = generate_id();

        // Get the requesting node's identity from the message source
        let node_id = source().node;

        // Store the mapping
        self.node_auth_tokens.insert(auth_token.clone(), node_id.clone());

        Ok(NodeHandshakeResp {
            auth_token,
        })
    }

    #[ws]
    fn websocket(&mut self, channel_id: u32, message_type: WsMessageType, blob: LazyLoadBlob) {
        kiprintln!("WebSocket event - channel_id: {}, type: {:?}", channel_id, message_type);
        match message_type {
            WsMessageType::Text => {
                if let Ok(message) = String::from_utf8(blob.bytes.clone()) {
                    kiprintln!("Received WebSocket text message from channel {} (connections: {:?}): {}", 
                        channel_id, self.connections.keys().collect::<Vec<_>>(), message);

                    // Parse the message as our client message type
                    match serde_json::from_str::<WsClientMessage>(&message) {
                        Ok(client_msg) => {
                            handle_client_message(self, channel_id, client_msg);
                        }
                        Err(e) => {
                            kiprintln!("Failed to parse WebSocket message: {}", e);
                            send_error_to_channel(channel_id, "Invalid message format");
                        }
                    }
                }
            }
            WsMessageType::Close => {
                kiprintln!("WebSocket connection {} closed", channel_id);
                handle_disconnect(self, channel_id);
            }
            _ => {
                kiprintln!("Received other WebSocket message type: {:?}", message_type);
            }
        }
    }


}

// Helper functions for WebSocket handling
fn handle_client_message(state: &mut VoiceState, channel_id: u32, msg: WsClientMessage) {
    match msg {
        WsClientMessage::JoinCall { call_id, auth_token, display_name } => {
            // Check if call exists
            if !state.calls.contains_key(&call_id) {
                send_error_to_channel(channel_id, "Call not found");
                return;
            }

            // Determine participant identity based on auth token
            let (participant_id, final_display_name, connection_type) = if let Some(token) = auth_token {
                // Authenticated join - look up node ID from auth token
                if let Some(node_id) = state.node_auth_tokens.get(&token) {
                    // Use node ID as both participant ID and display name
                    (node_id.clone(), display_name.unwrap_or_else(|| node_id.clone()), ConnectionType::Node(node_id.clone()))
                } else {
                    // Check if this is the host joining their own call
                    let host_node = call_id.split('-').next().unwrap_or("");
                    let our_node = our().node;

                    if host_node == our_node && state.calls.get(&call_id).map(|c| c.creator_id.is_none()).unwrap_or(false) {
                        // This is the host joining their own call
                        (our_node.clone(), display_name.unwrap_or_else(|| our_node.clone()), ConnectionType::Node(our_node))
                    } else {
                        send_error_to_channel(channel_id, "Invalid authentication token");
                        return;
                    }
                }
            } else {
                // Unauthenticated join - generate pleb ID
                let participant_id = generate_id();
                let final_display_name = display_name.unwrap_or_else(|| {
                    // Check if this is the first joiner (will become host)
                    if state.calls.get(&call_id).map(|c| c.creator_id.is_none()).unwrap_or(false) {
                        "Host".to_string()
                    } else {
                        generate_pleb_name_for_call(state, &call_id)
                    }
                });
                (participant_id, final_display_name, ConnectionType::Browser)
            };

            // Now add the participant to the call
            if let Some(call) = state.calls.get_mut(&call_id) {
                // Determine role and host
                let role = if call.creator_id.is_none() {
                    call.creator_id = Some(participant_id.clone());
                    call.host_id = Some(participant_id.clone()); // First participant becomes host
                    Role::Admin
                } else {
                    call.default_role.clone()
                };

                // Create new participant
                let participant = Participant {
                    id: participant_id.clone(),
                    display_name: final_display_name.clone(),
                    role,
                    connection_type,
                    is_muted: false,
                };

                // Add participant to call
                call.participants.insert(participant_id.clone(), participant.clone());

                // Store connection mapping
                kiprintln!("Storing connection - channel_id: {} -> participant_id: {}", channel_id, participant_id);
                state.connections.insert(channel_id, participant_id.clone());
                state.participant_channels.insert(participant_id.clone(), channel_id);

                // Track this channel as part of the call
                state.call_channels
                    .entry(call_id.clone())
                    .or_insert_with(HashSet::new)
                    .insert(channel_id);

                // Generate auth token for future messages
                let response_auth_token = generate_id();
                // Note: We don't store this in node_auth_tokens since it's for WebSocket auth only

                // Prepare response data
                let participants: Vec<ParticipantInfo> = call.participants.values()
                    .map(|p| ParticipantInfo {
                        id: p.id.clone(),
                        display_name: p.display_name.clone(),
                        role: p.role.clone(),
                        is_muted: p.is_muted,
                    })
                    .collect();

                let chat_history = call.chat_history.clone();

                // Send join success with host info
                send_to_channel(channel_id, WsServerMessage::JoinSuccess {
                    participant_id: participant_id.clone(),
                    role: participant.role.clone(),
                    participants,
                    chat_history,
                    auth_token: response_auth_token,
                    host_id: call.host_id.clone(),
                });

                // Notify other participants
                let participant_info = ParticipantInfo {
                    id: participant.id,
                    display_name: participant.display_name,
                    role: participant.role,
                    is_muted: participant.is_muted,
                };
                broadcast_to_call_except(state, &call_id, channel_id, WsServerMessage::ParticipantJoined(
                    WsParticipantJoined { participant: participant_info }
                ));
            } else {
                send_error_to_channel(channel_id, "Call not found");
            }
            return;
        }
        _ => {}
    }

    // For all other messages, require authentication
    kiprintln!("Checking auth for channel_id: {}, connections: {:?}", channel_id, state.connections.keys().collect::<Vec<_>>());
    let participant_id = match state.connections.get(&channel_id) {
        Some(id) => {
            kiprintln!("Found participant_id: {} for channel: {}", id, channel_id);
            id.clone()
        },
        None => {
            kiprintln!("No connection found for channel_id: {}", channel_id);
            send_error_to_channel(channel_id, "Not authenticated");
            return;
        }
    };

    // Find which call this participant is in
    let (call_id, participant_role) = match find_participant_call(state, &participant_id) {
        Some((cid, role)) => (cid, role),
        None => {
            send_error_to_channel(channel_id, "Not in a call");
            return;
        }
    };

    match msg {
        WsClientMessage::JoinCall { .. } => unreachable!(), // Already handled above
        WsClientMessage::Chat(content) => {
            // Check permission
            if !can_chat(&participant_role) {
                send_error_to_channel(channel_id, "No chat permission");
                return;
            }

            if let Some(call) = state.calls.get_mut(&call_id) {
                if let Some(participant) = call.participants.get(&participant_id) {
                    let chat_msg = ChatMessage {
                        id: generate_id(),
                        sender_id: participant_id.clone(),
                        sender_name: participant.display_name.clone(),
                        content,
                        timestamp: current_timestamp().unwrap_or(0),
                    };

                    call.chat_history.push(chat_msg.clone());

                    // Broadcast to all participants in the call
                    broadcast_to_call(state, &call_id, WsServerMessage::Chat(WsChatMessage {
                        message: chat_msg
                    }));
                }
            }
        }
        WsClientMessage::Mute(is_muted) => {
            if let Some(call) = state.calls.get_mut(&call_id) {
                if let Some(participant) = call.participants.get_mut(&participant_id) {
                    participant.is_muted = is_muted;

                    broadcast_to_call(state, &call_id, WsServerMessage::ParticipantMuted(
                        WsParticipantMuted {
                            participant_id: participant_id.clone(),
                            is_muted
                        }
                    ));
                }
            }
        }
        WsClientMessage::AudioData { data, sample_rate: _, channels: _, sequence, timestamp } => {
            kiprintln!("Received audio data from participant: {}", participant_id);

            // Check if the participant can speak
            if !matches!(participant_role, Role::Speaker | Role::Admin) {
                kiprintln!("Participant {} cannot speak (role: {:?})", participant_id, participant_role);
                send_error_to_channel(channel_id, "No audio permission");
                return;
            }

            // Decode base64 to bytes
            let audio_bytes = base64_to_bytes(&data);
            
            // Get or create audio processor for this call
            let processor = state.audio_processors.entry(call_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(AudioProcessor::new())))
                .clone();
            
            // Process audio in the audio processor
            if let Ok(mut proc) = processor.lock() {
                // Ensure participant is registered
                if !proc.has_participant(&participant_id) {
                    if let Err(e) = proc.add_participant(participant_id.clone()) {
                        kiprintln!("Failed to add participant to audio processor: {}", e);
                        return;
                    }
                }
                
                // Decode Opus data
                match proc.decode_audio(&participant_id, &audio_bytes) {
                    Ok(decoded_audio) => {
                        // Update participant's audio buffer
                        proc.update_participant_audio(&participant_id, decoded_audio);
                        
                        // Create all mix-minus outputs
                        let mixes = proc.create_mix_minus_outputs();
                        kiprintln!("Created {} mix-minus outputs", mixes.len());
                        
                        // Send personalized mix to each participant
                        for (target_id, mix_data) in mixes {
                            kiprintln!("Processing mix for target: {}, data size: {}", target_id, mix_data.len());
                            if target_id == "__listener__" {
                                // Broadcast listener mix to all non-speaking participants
                                broadcast_to_non_speakers(state, &call_id, mix_data, sequence, timestamp);
                            } else {
                                // Send personalized mix to specific participant
                                send_audio_to_participant(state, &target_id, mix_data, sequence, timestamp);
                            }
                        }
                    }
                    Err(e) => {
                        kiprintln!("Failed to decode audio: {}", e);
                    }
                }
            };
        }
        WsClientMessage::Heartbeat => {
            // Keep connection alive - no action needed
        }
    }

}

fn generate_call_id(dictionary: &[String]) -> String {
    let mut rng = rand::thread_rng();
    let words: Vec<String> = dictionary.choose_multiple(&mut rng, 3)
        .map(|s| s.clone())
        .collect();
    format!("{}-{}", our().node, words.join("-"))
}

fn generate_pleb_name_for_call(state: &mut VoiceState, call_id: &str) -> String {
    let dictionary = state.word_dictionary.clone();
    let used_names = state.used_pleb_names.entry(call_id.to_string()).or_insert_with(Vec::new);
    generate_pleb_name(&dictionary, used_names)
}

fn generate_pleb_name(dictionary: &[String], used_names: &mut Vec<String>) -> String {
    let mut rng = rand::thread_rng();
    loop {
        let word = dictionary.choose(&mut rng).unwrap();
        let name = format!("pleb-{}", word);
        if !used_names.contains(&name) {
            used_names.push(name.clone());
            return name;
        }
    }
}

fn generate_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{:x}", rng.gen::<u64>())
}

fn current_timestamp() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| e.to_string())
}

fn can_chat(role: &Role) -> bool {
    matches!(role, Role::Chatter | Role::Speaker | Role::Admin)
}

fn handle_disconnect(state: &mut VoiceState, channel_id: u32) {
    kiprintln!("Handling disconnect for channel_id: {}", channel_id);
    if let Some(participant_id) = state.connections.remove(&channel_id) {
        kiprintln!("Removed connection for participant: {}", participant_id);
        state.participant_channels.remove(&participant_id);

        // Find which call this participant is in
        let call_info = state.calls.iter()
            .find_map(|(cid, call)| {
                if call.participants.contains_key(&participant_id) {
                    Some((cid.clone(), call.host_id.clone()))
                } else {
                    None
                }
            });

        if let Some((call_id, host_id)) = call_info {
            // Remove participant from audio processor
            if let Some(processor) = state.audio_processors.get(&call_id) {
                if let Ok(mut proc) = processor.lock() {
                    proc.remove_participant(&participant_id);
                }
            }

            // Remove this channel from the call's channel set
            if let Some(channels) = state.call_channels.get_mut(&call_id) {
                channels.remove(&channel_id);
            }

            // Check if this participant is the host
            let is_host_leaving = host_id.as_ref() == Some(&participant_id);

            // Determine if we should end the call
            let should_end_call = {
                if let Some(call) = state.calls.get_mut(&call_id) {
                    call.participants.remove(&participant_id);
                    let is_empty = call.participants.is_empty();
                    is_empty || is_host_leaving
                } else {
                    false
                }
            };

            if should_end_call {
                kiprintln!("Ending call {} - host leaving: {}", call_id, is_host_leaving);

                // Disconnect all remaining participants
                disconnect_all_call_channels(state, &call_id);

                // Unserve the UI
                let call_path = format!("/call/{}", call_id);
                if let Err(e) = hyperware_app_common::get_server().unwrap().unserve_ui("ui-call", vec![&call_path]) {
                    kiprintln!("Failed to unserve UI for call {}: {:?}", call_id, e);
                }

                // Clean up call state - this must happen OUTSIDE the borrow scope
                state.calls.remove(&call_id);
                state.used_pleb_names.remove(&call_id);
                state.call_channels.remove(&call_id);
                state.audio_processors.remove(&call_id);
            } else {
                // Just notify remaining participants
                let notification = WsServerMessage::ParticipantLeft { participant_id: participant_id.clone() };
                broadcast_to_call(state, &call_id, notification);
            }
        }
    }
}

fn find_participant_call(state: &VoiceState, participant_id: &str) -> Option<(String, Role)> {
    for (call_id, call) in &state.calls {
        if let Some(participant) = call.participants.get(participant_id) {
            return Some((call_id.clone(), participant.role.clone()));
        }
    }
    None
}

fn broadcast_to_call(state: &VoiceState, call_id: &str, message: WsServerMessage) {
    if let Some(call) = state.calls.get(call_id) {
        let message_json = serde_json::to_string(&message).unwrap_or_default();
        let message_bytes = message_json.into_bytes();

        for participant_id in call.participants.keys() {
            if let Some(&channel_id) = state.participant_channels.get(participant_id) {
                let blob = LazyLoadBlob {
                    mime: Some("application/json".to_string()),
                    bytes: message_bytes.clone(),
                };
                send_ws_push(channel_id, WsMessageType::Text, blob);
            }
        }
    }
}

fn broadcast_to_call_except(state: &VoiceState, call_id: &str, except_channel: u32, message: WsServerMessage) {
    if let Some(call) = state.calls.get(call_id) {
        let message_json = serde_json::to_string(&message).unwrap_or_default();
        let message_bytes = message_json.into_bytes();

        for participant_id in call.participants.keys() {
            if let Some(&channel_id) = state.participant_channels.get(participant_id) {
                if channel_id != except_channel {
                    let blob = LazyLoadBlob {
                        mime: Some("application/json".to_string()),
                        bytes: message_bytes.clone(),
                    };
                    send_ws_push(channel_id, WsMessageType::Text, blob);
                }
            }
        }
    }
}

fn send_to_participant(state: &VoiceState, participant_id: &str, message: WsServerMessage) {
    if let Some(&channel_id) = state.participant_channels.get(participant_id) {
        let message_json = serde_json::to_string(&message).unwrap_or_default();
        let blob = LazyLoadBlob {
            mime: Some("application/json".to_string()),
            bytes: message_json.into_bytes(),
        };
        send_ws_push(channel_id, WsMessageType::Text, blob);
    }
}

fn send_to_channel(channel_id: u32, message: WsServerMessage) {
    let message_json = serde_json::to_string(&message).unwrap_or_default();
    let blob = LazyLoadBlob {
        mime: Some("application/json".to_string()),
        bytes: message_json.into_bytes(),
    };
    send_ws_push(channel_id, WsMessageType::Text, blob);
}

fn send_error_to_channel(channel_id: u32, error: &str) {
    let message = WsServerMessage::Error(error.to_string());
    send_to_channel(channel_id, message);
}

fn disconnect_all_call_channels(state: &VoiceState, call_id: &str) {
    if let Some(channels) = state.call_channels.get(call_id) {
        kiprintln!("Disconnecting {} WebSocket channels for call {}", channels.len(), call_id);

        // First send CallEnded message to all participants
        for &channel_id in channels {
            send_to_channel(channel_id, WsServerMessage::CallEnded);
        }

        // Then send WebSocket close message to trigger client disconnection
        for &channel_id in channels {
            let blob = LazyLoadBlob {
                mime: None,
                bytes: vec![],
            };
            send_ws_push(channel_id, WsMessageType::Close, blob);
        }
    }
}

fn base64_to_bytes(base64_str: &str) -> Vec<u8> {
    general_purpose::STANDARD.decode(base64_str).unwrap_or_default()
}

fn bytes_to_base64(bytes: &[u8]) -> String {
    general_purpose::STANDARD.encode(bytes)
}

fn send_audio_to_participant(state: &VoiceState, participant_id: &str, audio_data: Vec<u8>, sequence: Option<u32>, timestamp: Option<u64>) {
    if let Some(&channel_id) = state.participant_channels.get(participant_id) {
        let message = WsServerMessage::AudioData(WsAudioData {
            participant_id: participant_id.to_string(),
            data: bytes_to_base64(&audio_data),
            sequence,
            timestamp,
            sample_rate: Some(48000),
            channels: Some(1),
        });
        send_to_channel(channel_id, message);
    }
}

fn broadcast_to_non_speakers(state: &VoiceState, call_id: &str, audio_data: Vec<u8>, sequence: Option<u32>, timestamp: Option<u64>) {
    kiprintln!("Broadcasting to non-speakers in call {}, audio data size: {}", call_id, audio_data.len());
    
    // Get the call and find all non-speaking participants (Listeners and Chatters)
    if let Some(call) = state.calls.get(call_id) {
        let mut non_speaker_count = 0;
        for (participant_id, participant) in &call.participants {
            kiprintln!("Checking participant {} with role {:?}", participant_id, participant.role);
            // Send to Listeners and Chatters (they can't speak but need to hear)
            if matches!(participant.role, Role::Listener | Role::Chatter) {
                non_speaker_count += 1;
                // Send audio to this participant
                if let Some(&channel_id) = state.participant_channels.get(participant_id) {
                    kiprintln!("Sending audio to non-speaker {} on channel {}", participant_id, channel_id);
                    let message = WsServerMessage::AudioData(WsAudioData {
                        participant_id: "server-mix".to_string(), // Special ID for server mix
                        data: bytes_to_base64(&audio_data),
                        sequence,
                        timestamp,
                        sample_rate: Some(48000),
                        channels: Some(1),
                    });
                    send_to_channel(channel_id, message);
                } else {
                    kiprintln!("No channel found for non-speaker {}", participant_id);
                }
            }
        }
        kiprintln!("Found {} non-speakers in call", non_speaker_count);
    } else {
        kiprintln!("Call {} not found in state", call_id);
    }
}
