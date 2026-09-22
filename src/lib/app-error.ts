export type RoomMoveReloadResource =
  | 'reservation'
  | 'sourceRoom'
  | 'targetRoom'
  | 'roomMovePreview';

export interface RoomMoveConflict {
  reloadResources: RoomMoveReloadResource[];
  latestVersions: {
    reservationVersion: number | null;
    sourceRoomVersion: number | null;
    targetRoomVersion: number | null;
  };
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly headers?: Readonly<Record<string, string>>,
    public readonly conflict?: RoomMoveConflict
  ) {
    super(message);
    this.name = 'AppError';
  }
}

