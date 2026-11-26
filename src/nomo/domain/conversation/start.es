module nomo.domain.conversation.start;

public enum SessionSelection { Current, Fresh, Existing, Exact(string), Choose }
