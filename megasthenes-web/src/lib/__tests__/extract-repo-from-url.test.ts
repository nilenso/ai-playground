import { describe, expect, test } from "bun:test";
import { extractRepoFromUrl } from "../extract-repo-from-url.ts";

describe("extractRepoFromUrl", () => {
	describe("GitHub", () => {
		test("extracts from repo root", () => {
			const result = extractRepoFromUrl("https://github.com/nilenso/ai-playground");
			expect(result.repoUrl).toBe("https://github.com/nilenso/ai-playground");
			expect(result.error).toBeNull();
		});

		test("extracts from deep link (blob)", () => {
			const result = extractRepoFromUrl("https://github.com/nilenso/ai-playground/blob/main/README.md");
			expect(result.repoUrl).toBe("https://github.com/nilenso/ai-playground");
		});

		test("extracts from issues page", () => {
			const result = extractRepoFromUrl("https://github.com/nilenso/ai-playground/issues/123");
			expect(result.repoUrl).toBe("https://github.com/nilenso/ai-playground");
		});

		test("extracts from pull request page", () => {
			const result = extractRepoFromUrl("https://github.com/nilenso/ai-playground/pull/456");
			expect(result.repoUrl).toBe("https://github.com/nilenso/ai-playground");
		});

		test("rejects reserved paths", () => {
			expect(extractRepoFromUrl("https://github.com/settings/profile").repoUrl).toBeNull();
			expect(extractRepoFromUrl("https://github.com/explore").repoUrl).toBeNull();
			expect(extractRepoFromUrl("https://github.com/marketplace/actions").repoUrl).toBeNull();
			expect(extractRepoFromUrl("https://github.com/login").repoUrl).toBeNull();
		});

		test("rejects user profile page (no repo)", () => {
			const result = extractRepoFromUrl("https://github.com/nilenso");
			expect(result.repoUrl).toBeNull();
		});
	});

	describe("GitLab", () => {
		test("extracts from repo root", () => {
			const result = extractRepoFromUrl("https://gitlab.com/gitlab-org/gitlab");
			expect(result.repoUrl).toBe("https://gitlab.com/gitlab-org/gitlab");
		});

		test("extracts from merge request page", () => {
			const result = extractRepoFromUrl("https://gitlab.com/gitlab-org/gitlab/-/merge_requests/123");
			expect(result.repoUrl).toBe("https://gitlab.com/gitlab-org/gitlab");
		});

		test("handles subgroups", () => {
			const result = extractRepoFromUrl("https://gitlab.com/group/subgroup/project/-/pipelines");
			expect(result.repoUrl).toBe("https://gitlab.com/group/subgroup/project");
		});

		test("rejects reserved paths", () => {
			expect(extractRepoFromUrl("https://gitlab.com/explore/projects").repoUrl).toBeNull();
			expect(extractRepoFromUrl("https://gitlab.com/dashboard/issues").repoUrl).toBeNull();
		});
	});

	describe("Bitbucket", () => {
		test("extracts from repo root", () => {
			const result = extractRepoFromUrl("https://bitbucket.org/atlassian/python-bitbucket");
			expect(result.repoUrl).toBe("https://bitbucket.org/atlassian/python-bitbucket");
		});

		test("rejects reserved paths", () => {
			expect(extractRepoFromUrl("https://bitbucket.org/account/settings").repoUrl).toBeNull();
			expect(extractRepoFromUrl("https://bitbucket.org/dashboard/overview").repoUrl).toBeNull();
		});
	});

	describe("Codeberg", () => {
		test("extracts from repo root", () => {
			const result = extractRepoFromUrl("https://codeberg.org/forgejo/forgejo");
			expect(result.repoUrl).toBe("https://codeberg.org/forgejo/forgejo");
		});

		test("rejects reserved paths", () => {
			expect(extractRepoFromUrl("https://codeberg.org/explore/repos").repoUrl).toBeNull();
		});
	});

	describe("SourceHut", () => {
		test("extracts from repo root", () => {
			const result = extractRepoFromUrl("https://git.sr.ht/~sircmpwn/scdoc");
			expect(result.repoUrl).toBe("https://git.sr.ht/~sircmpwn/scdoc");
		});
	});

	describe("Non-forge URLs", () => {
		test("rejects non-forge domains", () => {
			expect(extractRepoFromUrl("https://google.com/some/page").repoUrl).toBeNull();
			expect(extractRepoFromUrl("https://google.com/some/page").error).toBe("Not a recognized code forge URL");
		});

		test("rejects invalid URLs", () => {
			expect(extractRepoFromUrl("not-a-url").repoUrl).toBeNull();
			expect(extractRepoFromUrl("not-a-url").error).toBe("Invalid URL");
		});
	});
});
