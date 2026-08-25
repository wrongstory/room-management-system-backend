import type { SupabaseClients } from '../../lib/supabase.js';
import { AppError } from '../../lib/app-error.js';

export interface RoomSummary {
  id: string;
  roomNumber: string;
  roomTypeCode: string;
  roomTypeName: string;
  elevatorZone: 'A' | 'B' | 'C' | null;
  dataStatus: 'verified' | 'verification_required';
}

export interface RoomService {
  list(accessToken: string): Promise<RoomSummary[]>;
}

export class SupabaseRoomService implements RoomService {
  constructor(private readonly clients: SupabaseClients) {}

  async list(accessToken: string): Promise<RoomSummary[]> {
    const client = this.clients.forAccessToken(accessToken);
    const { data, error } = await client
      .from('room_catalog')
      .select('id,room_number,room_type_code,room_type_name,elevator_zone,data_status')
      .order('room_number');

    if (error) {
      throw new AppError(500, 'ROOM_LIST_FAILED', '객실 목록을 불러오지 못했습니다.');
    }

    return (data ?? []).map((room) => ({
      id: room.id,
      roomNumber: room.room_number,
      roomTypeCode: room.room_type_code,
      roomTypeName: room.room_type_name,
      elevatorZone: room.elevator_zone,
      dataStatus: room.data_status
    })) as RoomSummary[];
  }
}

