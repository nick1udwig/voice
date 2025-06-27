use hyperprocess_macro::hyperprocess;
use hyperware_process_lib::http::server::{send_ws_push, WsMessageType};
use hyperware_process_lib::{kiprintln, LazyLoadBlob};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use rand::seq::SliceRandom;

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
    pub redirect_url: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WsClientMessage {
    #[serde(rename_all = "camelCase")]
    Authenticate { participant_id: String, auth_token: String },
    #[serde(rename_all = "camelCase")]
    JoinCall { call_id: String, display_name: Option<String> },
    Chat(String),
    Mute(bool),
    WebrtcSignal(SignalData),
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
pub struct WsWebrtcSignal {
    pub sender_id: String,
    pub signal: SignalData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WsServerMessage {
    #[serde(rename_all = "camelCase")]
    JoinSuccess { participant_id: String, role: Role, participants: Vec<ParticipantInfo>, chat_history: Vec<ChatMessage> },
    Chat(WsChatMessage),
    ParticipantJoined(WsParticipantJoined),
    ParticipantLeft(String),
    RoleUpdated(WsRoleUpdate),
    ParticipantMuted(WsParticipantMuted),
    WebrtcSignal(WsWebrtcSignal),
    Error(String),
    CallEnded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalData {
    pub target: String,
    pub signal_type: String,
    pub payload: String,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
struct VoiceState {
    calls: HashMap<String, Call>,
    connections: HashMap<u32, String>, // channel_id -> participant_id
    participant_channels: HashMap<String, u32>, // participant_id -> channel_id
    word_dictionary: Vec<String>,
    used_pleb_names: HashMap<String, Vec<String>>,
    node_auth_tokens: HashMap<String, String>, // auth_token -> node_id
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Call {
    id: String,
    participants: HashMap<String, Participant>,
    chat_history: Vec<ChatMessage>,
    created_at: u64,
    default_role: Role,
    creator_id: Option<String>,
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
    async fn join_call(&mut self, request: JoinCallReq) -> Result<JoinInfo, String> {
        let call = self.calls.get_mut(&request.call_id)
            .ok_or_else(|| "Call not found".to_string())?;

        let (participant_id, display_name, connection_type) = if let Some(auth_token) = request.node_auth {
            // Look up the node ID from the auth token
            if let Some(node_id) = self.node_auth_tokens.get(&auth_token) {
                (node_id.clone(), node_id.clone(), ConnectionType::Node(node_id.clone()))
            } else {
                return Err("Invalid authentication token".to_string());
            }
        } else {
            let pleb_name = generate_pleb_name(
                &self.word_dictionary,
                self.used_pleb_names.get_mut(&request.call_id).unwrap()
            );
            (pleb_name.clone(), pleb_name.clone(), ConnectionType::Browser)
        };

        // First participant becomes the creator with Admin role
        let role = if call.creator_id.is_none() {
            call.creator_id = Some(participant_id.clone());
            Role::Admin
        } else {
            call.default_role.clone()
        };

        let participant = Participant {
            id: participant_id.clone(),
            display_name: display_name.clone(),
            role,
            connection_type,
            is_muted: true,
        };

        call.participants.insert(participant_id.clone(), participant.clone());

        // Generate auth token for WebSocket authentication
        let auth_token = generate_id();

        let join_info = JoinInfo {
            call_id: request.call_id,
            participant_id: participant_id.clone(),
            role: participant.role.clone(),
            auth_token: Some(auth_token),
        };

        Ok(join_info)
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
        let call = self.calls.get_mut(&request.call_id)
            .ok_or_else(|| "Call not found".to_string())?;

        call.participants.remove(&request.participant_id);
        self.connections.retain(|_, pid| pid != &request.participant_id);

        if call.participants.is_empty() {
            // Unserve the UI when the call ends
            let call_path = format!("/call/{}", request.call_id);
            if let Err(e) = hyperware_app_common::get_server().unwrap().unserve_ui("ui-call", vec![&call_path]) {
                kiprintln!("Failed to unserve UI for call {}: {:?}", request.call_id, e);
            }
            
            self.calls.remove(&request.call_id);
            self.used_pleb_names.remove(&request.call_id);
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



    #[http(method = "POST", path = "/join-call-unauthenticated/{call_id}")]
    async fn join_call_unauthenticated(&mut self, call_id: String, request: JoinCallReq) -> Result<JoinInfo, String> {
        // For unauthenticated users, override the call_id from the request with the one from the path
        let mut req = request;
        req.call_id = call_id;
        self.join_call(req).await
    }


    
    #[http(method = "POST")]
    async fn node_handshake(&mut self, request: NodeHandshakeReq) -> Result<NodeHandshakeResp, String> {
        // Check if call exists
        if !self.calls.contains_key(&request.call_id) {
            return Err("Call not found".to_string());
        }

        // Generate auth token for this node
        let auth_token = generate_id();

        // Get the requesting node's identity from the context
        // In a real implementation, this would come from the Kinode authentication system
        let node_id = "requesting-node".to_string(); // TODO: Get actual node ID from context

        // Store the mapping
        self.node_auth_tokens.insert(auth_token.clone(), node_id);

        // Build redirect URL with auth token
        // Assuming the host URL is available in context
        let host_url = "https://voice.example.com"; // TODO: Get actual host URL
        let redirect_url = format!("{}/call/{}?auth={}", host_url, request.call_id, auth_token);

        Ok(NodeHandshakeResp {
            auth_token,
            redirect_url,
        })
    }

    #[ws]
    fn websocket(&mut self, channel_id: u32, message_type: WsMessageType, blob: LazyLoadBlob) {
        match message_type {
            WsMessageType::Text => {
                if let Ok(message) = String::from_utf8(blob.bytes.clone()) {
                    kiprintln!("Received WebSocket text message: {}", message);

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
        WsClientMessage::Authenticate { participant_id, auth_token: _ } => {
            // TODO: Validate auth_token

            // Check if participant exists in a call
            if let Some((call_id, role)) = find_participant_call(state, &participant_id) {
                // Store the connection mapping
                state.connections.insert(channel_id, participant_id.clone());
                state.participant_channels.insert(participant_id.clone(), channel_id);

                // Send current call state to the new participant
                if let Some(call) = state.calls.get(&call_id) {
                    let participants: Vec<ParticipantInfo> = call.participants.values()
                        .map(|p| ParticipantInfo {
                            id: p.id.clone(),
                            display_name: p.display_name.clone(),
                            role: p.role.clone(),
                            is_muted: p.is_muted,
                        })
                        .collect();
                    
                    let chat_history = call.chat_history.clone();
                    
                    // Send join success to the authenticating participant
                    send_to_channel(channel_id, WsServerMessage::JoinSuccess {
                        participant_id: participant_id.clone(),
                        role,
                        participants,
                        chat_history,
                    });

                    // Notify other participants
                    if let Some(participant) = call.participants.get(&participant_id) {
                        let participant_info = ParticipantInfo {
                            id: participant.id.clone(),
                            display_name: participant.display_name.clone(),
                            role: participant.role.clone(),
                            is_muted: participant.is_muted,
                        };
                        broadcast_to_call(state, &call_id, WsServerMessage::ParticipantJoined(
                            WsParticipantJoined { participant: participant_info }
                        ));
                    }
                }
            } else {
                send_error_to_channel(channel_id, "Invalid authentication");
            }
            return;
        }
        WsClientMessage::JoinCall { call_id, display_name } => {
            // Case 1: Direct WebSocket join for browser users without a node
            
            // Generate new participant ID
            let participant_id = generate_id();
            
            // Generate display name if not provided
            let display_name = display_name.unwrap_or_else(|| generate_pleb_name_for_call(state, &call_id));
            
            if let Some(call) = state.calls.get_mut(&call_id) {
                // Create new participant
                let participant = Participant {
                    id: participant_id.clone(),
                    display_name: display_name.clone(),
                    role: call.default_role.clone(),
                    connection_type: ConnectionType::Browser,
                    is_muted: false,
                };
                
                // Add participant to call
                call.participants.insert(participant_id.clone(), participant.clone());
                
                // Store connection mapping
                state.connections.insert(channel_id, participant_id.clone());
                state.participant_channels.insert(participant_id.clone(), channel_id);
                
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
                
                // Send join success to the joining participant
                send_to_channel(channel_id, WsServerMessage::JoinSuccess {
                    participant_id: participant_id.clone(),
                    role: participant.role.clone(),
                    participants,
                    chat_history,
                });
                
                // Notify other participants
                let participant_info = ParticipantInfo {
                    id: participant.id,
                    display_name: participant.display_name,
                    role: participant.role,
                    is_muted: participant.is_muted,
                };
                broadcast_to_call(state, &call_id, WsServerMessage::ParticipantJoined(
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
    let participant_id = match state.connections.get(&channel_id) {
        Some(id) => id.clone(),
        None => {
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
        WsClientMessage::Authenticate { .. } => unreachable!(), // Already handled above
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
        WsClientMessage::WebrtcSignal(signal) => {
            // Route WebRTC signaling to target participant
            let target = signal.target.clone();
            send_to_participant(state, &target, WsServerMessage::WebrtcSignal(
                WsWebrtcSignal {
                    sender_id: participant_id,
                    signal
                }
            ));
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
    words.join("-")
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

fn can_speak(role: &Role) -> bool {
    matches!(role, Role::Speaker | Role::Admin)
}

fn handle_disconnect(state: &mut VoiceState, channel_id: u32) {
    if let Some(participant_id) = state.connections.remove(&channel_id) {
        state.participant_channels.remove(&participant_id);

        // Find which call this participant is in
        let call_info = state.calls.iter()
            .find_map(|(cid, call)| {
                if call.participants.contains_key(&participant_id) {
                    Some((cid.clone(), call.participants.is_empty()))
                } else {
                    None
                }
            });

        if let Some((call_id, _)) = call_info {
            // Remove participant from call
            if let Some(call) = state.calls.get_mut(&call_id) {
                call.participants.remove(&participant_id);

                // Check if call is now empty
                let is_empty = call.participants.is_empty();

                // Prepare notification message
                let notification = WsServerMessage::ParticipantLeft(participant_id.clone());

                // Send notification to remaining participants
                if !is_empty {
                    broadcast_to_call(state, &call_id, notification);
                }

                // Clean up empty calls
                if is_empty {
                    // Unserve the UI when the call ends
                    let call_path = format!("/call/{}", call_id);
                    if let Err(e) = hyperware_app_common::get_server().unwrap().unserve_ui("ui-call", vec![&call_path]) {
                        kiprintln!("Failed to unserve UI for call {}: {:?}", call_id, e);
                    }
                    
                    state.calls.remove(&call_id);
                    state.used_pleb_names.remove(&call_id);
                }
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
