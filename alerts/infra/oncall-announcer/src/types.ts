export interface CurrentOncall {
  email?: string;
  escalationPolicyName?: string;
  escalationPolicySlug?: string;
  teamName?: string;
  teamSlug?: string;
  username: string;
}

export interface RotationState {
  email?: string;
  escalationPolicySlug?: string;
  slackUserId: string;
  teamSlug?: string;
  updatedAt: string;
  victoropsUsername: string;
}

export interface SlackUser {
  id: string;
  name?: string;
  realName?: string;
}

export interface RotationResult {
  announced: boolean;
  changed: boolean;
  current: CurrentOncall;
  previous?: RotationState;
  slackUserId: string;
}

export interface VictorOpsOncallResponse {
  teamsOnCall?: Array<{
    team?: {
      name?: string;
      slug?: string;
    };
    oncallNow?: Array<{
      escalationPolicy?: {
        name?: string;
        slug?: string;
      };
      users?: Array<{
        onCallUser?: {
          email?: string;
          username?: string;
        };
      }>;
    }>;
  }>;
}

export interface VictorOpsUsersResponse {
  users?: Array<{
    email?: string;
    username?: string;
  }>;
}
