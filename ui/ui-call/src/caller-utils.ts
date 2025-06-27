// Define a custom error type for API errors
export class ApiError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

// Parser for the Result-style responses
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseResultResponse<T>(response: any): T {
  if ('Ok' in response && response.Ok !== undefined && response.Ok !== null) {
    return response.Ok as T;
  }

  if ('Err' in response && response.Err !== undefined) {
    throw new ApiError(`API returned an error`, response.Err);
  }

  throw new ApiError('Invalid API response format');
}

/**
 * Generic API request function
 * @param endpoint - API endpoint
 * @param method - HTTP method (GET, POST, PUT, DELETE, etc.)
 * @param data - Request data
 * @returns Promise with parsed response data
 * @throws ApiError if the request fails or response contains an error
 */
async function apiRequest<T, R>(endpoint: string, method: string, data: T): Promise<R> {
  const BASE_URL = import.meta.env.BASE_URL || window.location.origin;

  const requestOptions: RequestInit = {
    method: method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  // Only add body for methods that support it
  if (method !== 'GET' && method !== 'HEAD') {
    requestOptions.body = JSON.stringify(data);
  }

  const result = await fetch(`${BASE_URL}/api`, requestOptions);

  if (!result.ok) {
    throw new ApiError(`HTTP request failed with status: ${result.status}`);
  }

  const jsonResponse = await result.json();
  return parseResultResponse<R>(jsonResponse);
}


// Custom Types from WIT definitions

export interface CallInfo {
  id: string;
  createdAt: number;
  participantCount: number;
  defaultRole: Role;
}

export interface CallState {
  callInfo: CallInfo;
  participants: ParticipantInfo[];
  chatHistory: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
}

export interface CreateCallReq {
  defaultRole: Role;
}

export interface JoinCallReq {
  callId: string;
  nodeAuth: string | null;
}

export interface JoinInfo {
  callId: string;
  participantId: string;
  role: Role;
  authToken: string | null;
}

export interface LeaveCallReq {
  callId: string;
  participantId: string;
}

export interface NodeHandshakeReq {
  callId: string;
}

export interface NodeHandshakeResp {
  authToken: string;
  redirectUrl: string;
}

export interface ParticipantInfo {
  id: string;
  displayName: string;
  role: Role;
  isMuted: boolean;
}

export interface UpdateRoleReq {
  callId: string;
  requesterId: string;
  targetId: string;
  newRole: Role;
}

export type Role = "Listener" | "Chatter" | "Speaker" | "Admin";


// API Interface Definitions

export interface CreateCallRequest {
  CreateCall: CreateCallReq
}

export interface GetCallInfoRequest {
  GetCallInfo: string
}

export interface JoinCallRequest {
  JoinCall: JoinCallReq
}

export interface JoinCallUnauthenticatedRequest {
  JoinCallUnauthenticated: [string, JoinCallReq]
}

export interface LeaveCallRequest {
  LeaveCall: LeaveCallReq
}

export interface NodeHandshakeRequest {
  NodeHandshake: NodeHandshakeReq
}

export interface UpdateRoleRequest {
  UpdateRole: UpdateRoleReq
}

export type CreateCallResponse = { Ok: CallInfo } | { Err: string };

export type GetCallInfoResponse = { Ok: CallState } | { Err: string };

export type JoinCallResponse = { Ok: JoinInfo } | { Err: string };

export type JoinCallUnauthenticatedResponse = { Ok: JoinInfo } | { Err: string };

export type LeaveCallResponse = { Ok: void } | { Err: string };

export type NodeHandshakeResponse = { Ok: NodeHandshakeResp } | { Err: string };

export type UpdateRoleResponse = { Ok: void } | { Err: string };

// API Function Implementations

/**
 * createCall
 * @param request: CreateCallReq * @returns Promise with result
 * @throws ApiError if the request fails
 */
export async function createCall(request: CreateCallReq): Promise<CallInfo> {
  const data: CreateCallRequest = {
    CreateCall: request,
  };

  return await apiRequest<CreateCallRequest, CallInfo>('createCall', 'POST', data);
}

/**
 * getCallInfo
 * @param callId: string * @returns Promise with result
 * @throws ApiError if the request fails
 */
export async function getCallInfo(callId: string): Promise<CallState> {
  const data: GetCallInfoRequest = {
    GetCallInfo: callId,
  };

  return await apiRequest<GetCallInfoRequest, CallState>('getCallInfo', 'POST', data);
}

/**
 * joinCall
 * @param request: JoinCallReq * @returns Promise with result
 * @throws ApiError if the request fails
 */
export async function joinCall(request: JoinCallReq): Promise<JoinInfo> {
  const data: JoinCallRequest = {
    JoinCall: request,
  };

  return await apiRequest<JoinCallRequest, JoinInfo>('joinCall', 'POST', data);
}

/**
 * joinCallUnauthenticated
 * @param callId: string
 * @param request: JoinCallReq * @returns Promise with result
 * @throws ApiError if the request fails
 */
export async function joinCallUnauthenticated(callId: string, request: JoinCallReq): Promise<JoinInfo> {
  const data: JoinCallUnauthenticatedRequest = {
    JoinCallUnauthenticated: [callId, request],
  };

  return await apiRequest<JoinCallUnauthenticatedRequest, JoinInfo>('joinCallUnauthenticated', 'POST', data);
}

/**
 * leaveCall
 * @param request: LeaveCallReq * @returns Promise with result
 * @throws ApiError if the request fails
 */
export async function leaveCall(request: LeaveCallReq): Promise<void> {
  const data: LeaveCallRequest = {
    LeaveCall: request,
  };

  return await apiRequest<LeaveCallRequest, void>('leaveCall', 'POST', data);
}

/**
 * nodeHandshake
 * @param request: NodeHandshakeReq * @returns Promise with result
 * @throws ApiError if the request fails
 */
export async function nodeHandshake(request: NodeHandshakeReq): Promise<NodeHandshakeResp> {
  const data: NodeHandshakeRequest = {
    NodeHandshake: request,
  };

  return await apiRequest<NodeHandshakeRequest, NodeHandshakeResp>('nodeHandshake', 'POST', data);
}

/**
 * updateRole
 * @param request: UpdateRoleReq * @returns Promise with result
 * @throws ApiError if the request fails
 */
export async function updateRole(request: UpdateRoleReq): Promise<void> {
  const data: UpdateRoleRequest = {
    UpdateRole: request,
  };

  return await apiRequest<UpdateRoleRequest, void>('updateRole', 'POST', data);
}

