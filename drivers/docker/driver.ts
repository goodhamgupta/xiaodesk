import type { AgentEvent, JobCard } from '../../packages/orchestrator/src/types.js';

/**
 * Optional Docker guest driver.
 *
 * The process driver is the default for this lab and for Linux CI.
 * This driver is the swap point for a container that mirrors the guest image:
 * Debian/Ubuntu userland, Codex App Server, and Lightpanda on 127.0.0.1:9222.
 *
 * Build (optional, not required for the stub demo):
 *   docker build -f drivers/docker/Dockerfile -t microvm-workshop-guest .
 *   DOCKER_GUEST_IMAGE=microvm-workshop-guest pnpm demo -- --driver docker
 */
export class DockerGuestDriver {
  async start(config: { id: string; job: JobCard }): Promise<void> {
    const image = process.env.DOCKER_GUEST_IMAGE;
    if (!image) {
      throw new Error(
        `Docker driver selected for ${config.id}, but DOCKER_GUEST_IMAGE is unset. ` +
        'Use --driver process for the lab, or build drivers/docker/Dockerfile and export DOCKER_GUEST_IMAGE.'
      );
    }
    throw new Error(
      `Docker driver stub: image ${image} is set, but the workshop ships the process driver as the runnable path. ` +
      `See drivers/docker/Dockerfile for the guest image layout (job ${config.job.id}).`
    );
  }

  async *runAgent(): AsyncGenerator<AgentEvent> {
    throw new Error('Docker guest was not started');
  }

  async stop(): Promise<void> {
    return undefined;
  }
}
