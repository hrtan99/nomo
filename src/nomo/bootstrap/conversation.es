module nomo.bootstrap.conversation;

import nomo.application.conversation.service.Conversation;
import nomo.application.conversation.service as service;
import nomo.adapters.filesystem.instructions.ProjectInstructionFiles;
import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, GenerationReservation, ResultPublication};
import nomo.application.execution.ports.AttemptRepository;
import nomo.adapters.storage.processes.NativeJobs;
import nomo.adapters.model.native.{NativeCodingModel, NativeSummaryModel};
import nomo.adapters.model.context_projection.RollingContext;
import nomo.bootstrap.configuration;
import nomo.bootstrap.configuration.ConfiguredConfiguration;
import nomo.adapters.cli.output.ConsoleLines;

public alias ConfiguredConversation<H ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication, A ~ AttemptRepository> = Conversation<H, A, ProjectInstructionFiles, NativeJobs, NativeCodingModel, NativeSummaryModel, RollingContext, ConfiguredConfiguration<H>, ConsoleLines>;

public flow create<H ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication, A ~ AttemptRepository>(history: H, attempts: A, instructions: ProjectInstructionFiles, jobs: NativeJobs, output: ConsoleLines) -> ConfiguredConversation<H, A> {
    return service.create<H, A, ProjectInstructionFiles, NativeJobs, NativeCodingModel, NativeSummaryModel, RollingContext, ConfiguredConfiguration<H>, ConsoleLines>() with {
        history: H => history;
        attempts: A => attempts;
        instructions: ProjectInstructionFiles => instructions;
        jobs: NativeJobs => jobs;
        coding: NativeCodingModel => NativeCodingModel {};
        summary: NativeSummaryModel => NativeSummaryModel {};
        projection: RollingContext => RollingContext {};
        configuration: ConfiguredConfiguration<H> => configuration.create(history);
        output: ConsoleLines => output;
    };
}
