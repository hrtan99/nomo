module nomo.bootstrap.conversation;

import nomo.application.conversation.service.Conversation;
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
    return ConfiguredConversation<H, A> {
        history,
        attempts,
        instructions,
        jobs,
        coding = NativeCodingModel {},
        summary = NativeSummaryModel {},
        projection = RollingContext {},
        configuration = configuration.create(history),
        output,
    };
}
