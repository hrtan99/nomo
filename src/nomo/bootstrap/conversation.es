module nomo.bootstrap.conversation;

import nomo.adapters.model.conversation_service.NativeConversation;
import nomo.adapters.model.conversation_service as service;
import nomo.adapters.filesystem.instructions.ProjectInstructionFiles;
import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, GenerationReservation, ResultPublication};
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.context.ports.{InstructionReader, SavedJobsReader, ContextProjection};
import nomo.application.conversation.effects.{CodingModel, SummaryModel};
import nomo.adapters.storage.processes.NativeJobs;
import nomo.adapters.model.native.{NativeCodingModel, NativeSummaryModel};
import nomo.adapters.model.context_projection.RollingContext;
import nomo.bootstrap.configuration.load as load_configuration;

public alias ConfiguredConversation<H ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication, A ~ AttemptRepository> = NativeConversation<H, A, ProjectInstructionFiles, NativeJobs, NativeCodingModel, NativeSummaryModel, RollingContext>;

public flow create<H ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication, A ~ AttemptRepository>(history: H, attempts: A) -> ConfiguredConversation<H, A> {
    return service.create<H, A, ProjectInstructionFiles, NativeJobs, NativeCodingModel, NativeSummaryModel, RollingContext>(() => load_configuration(history)) with {
        history: H => history;
        attempts: A => attempts;
        instructions: ProjectInstructionFiles => ProjectInstructionFiles {};
        jobs: NativeJobs => NativeJobs {};
        coding: NativeCodingModel => NativeCodingModel {};
        summary: NativeSummaryModel => NativeSummaryModel {};
        projection: RollingContext => RollingContext {};
    };
}
