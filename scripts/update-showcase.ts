// This script is based on the one from Astro:
// https://github.com/withastro/astro.build/blob/main/scripts/update-showcase.mjs#L48

import octokit from "@octokit/graphql";
import type { Repository } from "@octokit/graphql-schema";
import ghActions from "@actions/core";
import { nameToEmoji } from 'gemoji';
import { parseHTML } from "linkedom";
import fs from "node:fs/promises";
import * as dotenv from "dotenv";
import gh from 'parse-github-url';

import type { Showcase } from "../src/content/config";

dotenv.config();

const emojiRegex = /:(\+1|[-\w]+):/g

class ShowcaseScraper {
  /** A GraphQL client that uses our authorization token by default. */
  #query;
  /** The GitHub user or org to scrape. */
  #org;
  /** The name of the GitHub repo to scrape. */
  #repo;
  /** The number of the discussion to use as the data source. */
  #discussion;
  /** Array of origins that should never be added to the showcase. */
  #blocklist;

  constructor(org: string, repo: string, discussion: number, blockedOrigins: string[]) {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN env variable must be set to run.");
    }

    this.#query = octokit.graphql.defaults({
      headers: {
        authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    });

    this.#org = org;
    this.#repo = repo;
    this.#discussion = discussion;
    this.#blocklist = new Set(blockedOrigins.map((url) => new URL(url).origin));
  }

  /**
   * Run the showcase scraper, extract & filter links from the GitHub discussion, and add them to the repo.
   */
  async run(): Promise<void> {
    console.log(
      `Fetching comments from ${this.#org}/${this.#repo} discussion #${
        this.#discussion
      }...`
    );

    const comments = await this.#getDiscussionCommentsHTML();

    console.log("Extracting URLs...");

    const showcases: Showcase[] = [];

    for (const comment of comments) {
      const hrefs = this.#filterHrefs(this.#extractHrefs(comment.html));

      if (hrefs.length > 0) {
        const links: Showcase["links"] = [];
        for (const href of hrefs) {
          const ghReference = gh(href);

          if (ghReference?.owner && ghReference?.name) {
            console.log(`Adding repository data from ${href}...`);
            const { repository } = await this.#getRepository(ghReference.owner, ghReference.name);

            links.push({
              type: "github_repo",
              avatarUrl: repository.owner.avatarUrl,
              contributors: repository.mentionableUsers.totalCount,
              description: repository.description ? this.#emojify(repository.description) : "",
              discussions: repository.discussions.totalCount,
              forks: repository.forkCount,
              issues: repository.issues.totalCount,
              name: repository.name,
              owner: repository.owner.login,
              prs: repository.pullRequests.totalCount,
              stars: repository.stargazerCount,
              url: repository.url,
            });
          } else if (ghReference?.hostname === "github.com") {
            console.log(`Adding github link ${href}...`);
            links.push({
              type: "github",
              url: href,
            });
          } else {
            console.log(`Adding ${href}...`);
            links.push({
              type: 'unknown',
              url: href,
            });
          }
        }

        if (links.length > 0) {
          showcases.push({ author: comment.author, links });
        }
      }
    }

    await this.#saveDataFile(showcases);

    this.setActionOutput(showcases);
  }

  /**
   * Execute a GraphQL query to fetch discussion comments from the GitHub API.
   */
  #getDiscussionComments({ first = 100, after = "null" } = {}) {
    return this.#query<{ repository: Repository }>(`query {
    repository(owner: "${this.#org}", name: "${this.#repo}") {
      discussion(number: ${this.#discussion}) {
        bodyHTML
        comments(first: ${first}, after: ${after || "null"}) {
          pageInfo {
            endCursor
            hasNextPage
          }
          nodes {
            author {
              login
            }
            bodyHTML
          }
         }
       }
     }
   }`);
  }

  /**
   * Execute a GraphQL query to fetch repository data from the GitHub API.
   */
  #getRepository(owner: string, name: string) {
    return this.#query<{ repository: Repository }>(`
      query {
        repository(owner: "${owner}", name: "${name}") {
          description
          discussions(states: OPEN) {
            totalCount
          }
          forkCount
          issues(states: OPEN) {
            totalCount
          }
          mentionableUsers {
            totalCount
          }
          name
          owner {
            avatarUrl
            login
          }
          pullRequests(states: OPEN) {
            totalCount
          }
          stargazerCount
          url
        }
    }`);
  }

  /**
   * Get an array of the HTML of all comments in a specific GitHub Discussion
   */
  async #getDiscussionCommentsHTML() {
    const allCommentsHTML: { author: string; html: string }[] = [];

    let hasNextPage = true;
    let after = "";
    while (hasNextPage) {
      const { repository } = await this.#getDiscussionComments({ after });

      if (!repository.discussion) {
        break;
      }

      const { comments } = repository.discussion;

      comments.nodes?.forEach((node) => {
        if (!node?.author || !node?.bodyHTML) {
          return;
        }

        allCommentsHTML.push({
          author: node.author.login,
          html: node.bodyHTML,
        });
      });

      const endCursor = comments.pageInfo.endCursor;
      const hasEndCursor = !!endCursor;
      hasNextPage = comments.pageInfo.hasNextPage && hasEndCursor;

      if (hasNextPage && hasEndCursor) {
        after = endCursor;
      }
    }
    return allCommentsHTML;
  }

  /**
   * @param html HTML to parse and extract links from
   * @returns Array of URLs found in link `href` attributes.
   */
  #extractHrefs(html: string): string[] {
    const { document } = parseHTML(html);
    const links = document.querySelectorAll("a");
    const hrefs = [...links]
      .map((link) => link.href)
      .filter((href) => Boolean(href));
    return [...new Set(hrefs)];
  }

  /**
   * Filter out URLs we already added or that are excluded by the list of blocked origins.
   * @param hrefs Array of URLs as returned by `#extractHrefs`.
   */
  #filterHrefs(hrefs: string[]): string[] {
    return hrefs.filter((href) => {
      const { origin } = new URL(href);
      return !this.#blocklist.has(origin);
    });
  }

  /**
   * Create a JSON file in the `src/data` directory.
   * @param showcases Content of the showcase sites
   */
  async #saveDataFile(showcases: Showcase[]) {
    for (const showcase of showcases) {
      await fs.writeFile(
        `src/content/showcase/${showcase.author}.json`,
        JSON.stringify(showcase, null, 2),
        "utf8"
      );
    }
  }

  /**
   * Expose data from this run to GitHub Actions for use in other steps.
   * We set a `prBody` output for use when creating a PR from this run’s changes.
   */
  setActionOutput(showcases: Showcase[]) {
    const prLines = [
      "This PR is auto-generated by a GitHub action that runs every Monday to update the Open {re}Source showcase with data from GitHub and NPM.",
      "",
    ];

    if (showcases.length > 0) {
      prLines.push(
        "#### Links in this PR 🆕",
        "",
        ...showcases.map((showcase) => `- ${showcase.links.map(content => content.url).join(" - ")}`),
        ""
      );
    }

    if (process.env.CI) {
      ghActions.setOutput("prBody", prLines.join("\n"));
    } else {
      console.log(prLines.join("\n"));
    }
  }

  #emojify(text: string) {
    const slices: string[] = []

    let position = 0 
    emojiRegex.lastIndex = 0
    let match = emojiRegex.exec(text)

    while (match) {
      const code = match[1]

      // If the code is not in the emoji map, strip it out.
      if (!(code in nameToEmoji)) {
        position += code.length + 3
        match = emojiRegex.exec(text)
        continue
      }

      // Get the start and end positions of the emoji code including the colons.
      const start = match.index
      const end = start + code.length + 2
      
      // Append the text before the emoji if there is any.
      if (start !== position) {
        slices.push(text.slice(position, start))
      }

      // Append the emoji.
      slices.push(nameToEmoji[code])

      // Update the position and find the next match.
      position = end
      match = emojiRegex.exec(text)
    }

    // Append the text after the last emoji if there is any.
    slices.push(text.slice(position))

    return slices.join("")
  }
}

const scraper = new ShowcaseScraper("Open-reSource", "openresource.dev", 3, [
  "https://user-images.githubusercontent.com",
  "https://camo.githubusercontent.com",
  "https://openresource.dev",
  "https://www.openresource.dev",
]);

await scraper.run();