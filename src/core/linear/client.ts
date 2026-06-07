import type { LinearIssue } from "./types";

type FetchFn = typeof fetch;

export interface LinearClientI {
  fetchTriggerIssues(slugId: string, state: string): Promise<LinearIssue[]>;
  fetchStateNameByIssue(issueId: string): Promise<string | null>;
  fetchWorkflowStates(projectSlugId: string): Promise<Array<{ id: string; name: string; type: string }>>;
  updateState(issueId: string, stateId: string): Promise<void>;
  createComment(issueId: string, body: string): Promise<string>;
  updateComment(commentId: string, body: string): Promise<void>;
}

const Q_TRIGGER = `query($slug:String!,$state:String!){ issues(filter:{project:{slugId:{eq:$slug}}, state:{name:{eq:$state}}}, first:25){ nodes{ id identifier title description state{name} labels{ nodes{ name } } } } }`;
const Q_STATE = `query($id:String!){ issue(id:$id){ state{ name } } }`;
const Q_WORKFLOW_STATES = `query($slug:String!){ projects(filter:{slugId:{eq:$slug}}, first:1){ nodes{ teams{ nodes{ states{ nodes{ id name type } } } } } } }`;
const M_STATE = `mutation($id:String!,$stateId:String!){ issueUpdate(id:$id, input:{stateId:$stateId}){ success } }`;
const M_COMMENT = `mutation($issueId:String!,$body:String!){ commentCreate(input:{issueId:$issueId, body:$body}){ success comment{ id } } }`;
const M_COMMENT_UPD = `mutation($id:String!,$body:String!){ commentUpdate(id:$id, input:{body:$body}){ success } }`;

export class LinearClient implements LinearClientI {
  constructor(private key: string, private fetchFn: FetchFn = fetch) {}

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await this.fetchFn("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j: any = await r.json();
    if (j.errors) throw new Error(`Linear GraphQL: ${JSON.stringify(j.errors)}`);
    return j.data as T;
  }

  async fetchTriggerIssues(slugId: string, state: string): Promise<LinearIssue[]> {
    const d = await this.gql<{ issues: { nodes: any[] } }>(Q_TRIGGER, { slug: slugId, state });
    return d.issues.nodes.map((n) => ({
      id: n.id, identifier: n.identifier, title: n.title, description: n.description ?? null,
      stateName: n.state.name, labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
    }));
  }

  async fetchStateNameByIssue(issueId: string): Promise<string | null> {
    const d = await this.gql<{ issue: { state: { name: string } } | null }>(Q_STATE, { id: issueId });
    return d.issue?.state.name ?? null;
  }

  async fetchWorkflowStates(projectSlugId: string): Promise<Array<{ id: string; name: string; type: string }>> {
    const d = await this.gql<{
      projects: { nodes: Array<{ teams: { nodes: Array<{ states: { nodes: Array<{ id: string; name: string; type: string }> } }> } }> };
    }>(Q_WORKFLOW_STATES, { slug: projectSlugId });
    const seen = new Set<string>();
    const result: Array<{ id: string; name: string; type: string }> = [];
    for (const project of d.projects.nodes) {
      for (const team of project.teams.nodes) {
        for (const state of team.states.nodes) {
          if (!seen.has(state.id)) { seen.add(state.id); result.push({ id: state.id, name: state.name, type: state.type }); }
        }
      }
    }
    return result;
  }

  async updateState(issueId: string, stateId: string): Promise<void> {
    await this.gql(M_STATE, { id: issueId, stateId });
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const d = await this.gql<{ commentCreate: { comment: { id: string } } }>(M_COMMENT, { issueId, body });
    return d.commentCreate.comment.id;
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    await this.gql(M_COMMENT_UPD, { id: commentId, body });
  }
}
