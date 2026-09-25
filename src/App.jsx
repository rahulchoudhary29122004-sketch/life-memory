import { useEffect, useState } from "react";
import { supabase } from "./supabase";

function App() {
  const [memory, setMemory] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddMemory, setShowAddMemory] = useState(false);

  const [savedMemories, setSavedMemories] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [aiAnswer, setAiAnswer] = useState("");

  const [connectionStatus, setConnectionStatus] = useState("checking");
  const [userId, setUserId] = useState(null);

  const [loadingMemories, setLoadingMemories] = useState(true);
  const [savingMemory, setSavingMemory] = useState(false);
  const [searching, setSearching] = useState(false);

  // ----------------------------------------
  // 1. Connect / create anonymous user
  // ----------------------------------------
  useEffect(() => {
    async function initializeLifeMemory() {
      try {
        setConnectionStatus("checking");

        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) throw sessionError;

        let currentSession = session;

        if (!currentSession) {
          const {
            data: { session: newSession },
            error: anonymousError,
          } = await supabase.auth.signInAnonymously();

          if (anonymousError) throw anonymousError;

          currentSession = newSession;
        }

        if (!currentSession?.user) {
          throw new Error("Could not create Life Memory user.");
        }

        const currentUserId = currentSession.user.id;

        setUserId(currentUserId);
        setConnectionStatus("connected");

        console.log("Life Memory user:", currentUserId);

        await loadMemories(currentUserId);
      } catch (error) {
        console.error("Life Memory initialization error:", error);
        setConnectionStatus("error");
      } finally {
        setLoadingMemories(false);
      }
    }

    initializeLifeMemory();
  }, []);

  // ----------------------------------------
  // 2. Load memories
  // ----------------------------------------
  async function loadMemories(currentUserId) {
    const { data, error } = await supabase
      .from("memories")
      .select("id, created_at, content, user_id")
      .eq("user_id", currentUserId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const formattedMemories = (data || []).map((item) => ({
      id: item.id,
      text: item.content,
      date: new Date(item.created_at).toLocaleString(),
    }));

    setSavedMemories(formattedMemories);
  }

  // ----------------------------------------
  // 3. Generate embedding for saved memory
  // ----------------------------------------
  async function generateMemoryEmbedding(memoryId, content) {
    const { data, error } = await supabase.functions.invoke(
      "generate-embedding",
      {
        body: {
          mode: "memory",
          memoryId,
          content,
        },
      }
    );

    if (error) throw error;

    if (!data?.success) {
      throw new Error(
        data?.error || "Embedding generation failed."
      );
    }

    console.log(
      "Memory embedding generated:",
      memoryId,
      data.dimensions
    );

    return data;
  }

  // ----------------------------------------
  // 4. Semantic search + AI answer
  // ----------------------------------------
  async function semanticSearch(query) {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setSearchResults([]);
      setAiAnswer("");
      return;
    }

    setSearching(true);
    setAiAnswer("");

    try {
      // ----------------------------------------
      // STEP 1: Generate query embedding
      // ----------------------------------------
      const { data, error } = await supabase.functions.invoke(
        "generate-embedding",
        {
          body: {
            mode: "search",
            content: trimmedQuery,
          },
        }
      );

      if (error) throw error;

      if (!data?.success || !data?.embedding) {
        throw new Error(
          data?.error ||
            "Search embedding could not be generated."
        );
      }

      // ----------------------------------------
      // STEP 2: Find related memories
      // ----------------------------------------
      const { data: matches, error: matchError } =
        await supabase.rpc("match_memories", {
          query_embedding: data.embedding,
          match_threshold: 0.35,
          match_count: 10,
        });

      if (matchError) throw matchError;

      const results = (matches || []).map((item) => ({
        id: item.id,
        text: item.content,
        similarity: item.similarity,
      }));

      setSearchResults(results);

      console.log(
        "Semantic search results:",
        results
      );

      // ----------------------------------------
      // STEP 3: Ask Life Memory AI
      // ----------------------------------------
      if (results.length > 0) {
        const {
          data: answerData,
          error: answerError,
        } = await supabase.functions.invoke(
          "answer-memory",
          {
            body: {
              query: trimmedQuery,
              memories: results,
            },
          }
        );

        if (answerError) throw answerError;

        if (!answerData?.success || !answerData?.answer) {
          throw new Error(
            answerData?.error ||
              "AI could not generate an answer."
          );
        }

        setAiAnswer(answerData.answer);

        console.log(
          "Life Memory AI answer:",
          answerData.answer
        );
      } else {
        setAiAnswer(
          "I could not find any related memories for this question."
        );
      }
    } catch (error) {
      console.error(
        "Semantic search / AI answer error:",
        error
      );

      alert(
        error?.message ||
          "Memory search failed. Please try again."
      );

      setSearchResults([]);
      setAiAnswer("");
    } finally {
      setSearching(false);
    }
  }

  // ----------------------------------------
  // 5. Save memory
  // ----------------------------------------
  async function saveMemory() {
    const trimmedMemory = memory.trim();

    if (!trimmedMemory || !userId || savingMemory) return;

    setSavingMemory(true);

    try {
      const { data, error } = await supabase
        .from("memories")
        .insert([
          {
            content: trimmedMemory,
            user_id: userId,
          },
        ])
        .select("id, created_at, content")
        .single();

      if (error) throw error;

      const newMemory = {
        id: data.id,
        text: data.content,
        date: new Date(data.created_at).toLocaleString(),
      };

      setSavedMemories((prev) => [
        newMemory,
        ...prev,
      ]);

      setMemory("");
      setShowAddMemory(false);

      try {
        await generateMemoryEmbedding(
          data.id,
          data.content
        );

        console.log(
          "Memory is semantically searchable."
        );
      } catch (embeddingError) {
        console.error(
          "Embedding generation error:",
          embeddingError
        );

        alert(
          "Memory was saved, but AI understanding could not be generated."
        );
      }
    } catch (error) {
      console.error("Memory save error:", error);
      alert(
        "Memory could not be saved. Please try again."
      );
    } finally {
      setSavingMemory(false);
    }
  }

  // ----------------------------------------
  // 6. Delete memory
  // ----------------------------------------
  async function deleteMemory(id) {
    if (!userId) return;

    try {
      const { error } = await supabase
        .from("memories")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);

      if (error) throw error;

      setSavedMemories((prev) =>
        prev.filter((item) => item.id !== id)
      );

      setSearchResults((prev) =>
        prev.filter((item) => item.id !== id)
      );
    } catch (error) {
      console.error(
        "Memory delete error:",
        error
      );

      alert("Memory could not be deleted.");
    }
  }

  // ----------------------------------------
  // 7. Search button
  // ----------------------------------------
  async function handleSearch() {
    await semanticSearch(searchQuery);
  }

  const displayingSearchResults =
    searchQuery.trim().length > 0;

  return (
    <div style={styles.page}>
      <div style={styles.container}>

        {/* HEADER */}
        <div style={styles.header}>
          <div style={styles.logo}>
            LIFE MEMORY
          </div>

          <div style={styles.tagline}>
            YOUR PERSONAL MEMORY
          </div>
        </div>

        <h1 style={styles.title}>
          Never forget what matters.
        </h1>

        <p style={styles.description}>
          Save your thoughts, moments, documents and memories.
          <br />
          Life Memory helps you find them whenever you need them.
        </p>

        {/* CONNECTION STATUS */}
        <div style={styles.status}>
          <span
            style={{
              ...styles.statusDot,
              background:
                connectionStatus === "connected"
                  ? "#35e58b"
                  : connectionStatus === "error"
                  ? "#ff5c5c"
                  : "#f0c75e",
            }}
          />

          {connectionStatus === "connected"
            ? "Cloud connection ready"
            : connectionStatus === "error"
            ? "Cloud connection error"
            : "Connecting to Life Memory cloud..."}
        </div>

        {/* SEARCH */}
        <div style={styles.searchBox}>
          <span style={styles.searchIcon}>
            ⌕
          </span>

          <input
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);

              if (!e.target.value.trim()) {
                setSearchResults([]);
                setAiAnswer("");
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSearch();
              }
            }}
            placeholder="Search your memories..."
            style={styles.searchInput}
          />

          {searchQuery && (
            <button
              onClick={() => {
                setSearchQuery("");
                setSearchResults([]);
                setAiAnswer("");
              }}
              style={styles.clearButton}
            >
              ×
            </button>
          )}

          <button
            onClick={handleSearch}
            style={styles.searchButton}
            disabled={searching}
          >
            {searching
              ? "Thinking..."
              : "Search"}
          </button>
        </div>

        {/* ADD MEMORY */}
        <button
          onClick={() =>
            setShowAddMemory(true)
          }
          style={styles.addButton}
          disabled={!userId}
        >
          <span style={{ fontSize: 25 }}>
            +
          </span>

          Add a memory
        </button>

        {loadingMemories && (
          <div style={styles.loading}>
            Loading your memories...
          </div>
        )}

        {/* AI ANSWER */}
        {!loadingMemories &&
          displayingSearchResults &&
          aiAnswer && (
            <div style={styles.aiAnswerCard}>
              <div style={styles.aiAnswerLabel}>
                ✦ LIFE MEMORY AI
              </div>

              <div style={styles.aiAnswerText}>
                {aiAnswer}
              </div>
            </div>
          )}

        {/* RELATED MEMORIES */}
        {!loadingMemories &&
          displayingSearchResults &&
          searchResults.length > 0 && (
            <div style={styles.memoryList}>

              <div style={styles.resultTitle}>
                AI found{" "}
                {searchResults.length} related memor
                {searchResults.length === 1
                  ? "y"
                  : "ies"}
              </div>

              {searchResults.map((item) => (
                <div
                  key={item.id}
                  style={styles.memoryCard}
                >
                  <div style={styles.memoryTop}>

                    <span
                      style={styles.memoryLabel}
                    >
                      AI MATCH
                    </span>

                    <span
                      style={styles.similarity}
                    >
                      {Math.round(
                        item.similarity * 100
                      )}
                      % match
                    </span>
                  </div>

                  <p style={styles.memoryText}>
                    {item.text}
                  </p>

                  <button
                    onClick={() =>
                      deleteMemory(item.id)
                    }
                    style={styles.deleteButton}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}

        {/* NO RESULTS */}
        {!loadingMemories &&
          displayingSearchResults &&
          !searching &&
          searchResults.length === 0 && (
            <div style={styles.empty}>

              <div style={styles.emptyIcon}>
                🔎
              </div>

              <h2>
                No related memories found
              </h2>

              <p>
                Try describing what you remember
                in different words.
              </p>

              <button
                onClick={() => {
                  setSearchQuery("");
                  setSearchResults([]);
                  setAiAnswer("");
                }}
                style={styles.showAllButton}
              >
                Show all memories
              </button>
            </div>
          )}

        {/* EMPTY STATE */}
        {!displayingSearchResults &&
          !loadingMemories &&
          savedMemories.length === 0 && (
            <div style={styles.cards}>

              <div style={styles.card}>
                <div style={styles.cardIcon}>
                  🧠
                </div>

                <h3>Remember</h3>

                <p>
                  Save the moments, ideas and
                  information that matter to you.
                </p>
              </div>

              <div style={styles.card}>
                <div style={styles.cardIcon}>
                  🔍
                </div>

                <h3>Find</h3>

                <p>
                  Search your memories whenever
                  you need something from your past.
                </p>
              </div>

              <div style={styles.card}>
                <div style={styles.cardIcon}>
                  ✨
                </div>

                <h3>Understand</h3>

                <p>
                  Life Memory understands the
                  meaning behind your memories.
                </p>
              </div>

            </div>
          )}

        {/* ALL MEMORIES */}
        {!displayingSearchResults &&
          !loadingMemories &&
          savedMemories.length > 0 && (
            <div style={styles.memoryList}>

              {savedMemories.map((item) => (
                <div
                  key={item.id}
                  style={styles.memoryCard}
                >

                  <div style={styles.memoryTop}>

                    <span
                      style={styles.memoryLabel}
                    >
                      MEMORY
                    </span>

                    <span
                      style={styles.memoryDate}
                    >
                      {item.date}
                    </span>

                  </div>

                  <p style={styles.memoryText}>
                    {item.text}
                  </p>

                  <button
                    onClick={() =>
                      deleteMemory(item.id)
                    }
                    style={styles.deleteButton}
                  >
                    Delete
                  </button>

                </div>
              ))}

            </div>
          )}
      </div>

      {/* ADD MEMORY MODAL */}
      {showAddMemory && (
        <div
          style={styles.overlay}
          onClick={() =>
            setShowAddMemory(false)
          }
        >

          <div
            style={styles.modal}
            onClick={(e) =>
              e.stopPropagation()
            }
          >

            <button
              onClick={() =>
                setShowAddMemory(false)
              }
              style={styles.closeButton}
            >
              ×
            </button>

            <div style={styles.modalIcon}>
              🧠
            </div>

            <h2 style={styles.modalTitle}>
              Add a memory
            </h2>

            <p style={styles.modalDescription}>
              Write anything you want Life Memory
              to remember.
            </p>

            <textarea
              value={memory}
              onChange={(e) =>
                setMemory(e.target.value)
              }
              placeholder="For example: Aman and I discussed our college project today..."
              style={styles.textarea}
              autoFocus
            />

            <button
              onClick={saveMemory}
              style={{
                ...styles.saveButton,
                opacity: savingMemory
                  ? 0.7
                  : 1,
              }}
              disabled={savingMemory}
            >
              {savingMemory
                ? "Understanding memory..."
                : "Save memory ✦"}
            </button>

          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(circle at top, #111936 0%, #060812 48%, #03050a 100%)",
    color: "#ffffff",
    fontFamily:
      "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    padding: "55px 25px",
    boxSizing: "border-box",
  },

  container: {
    maxWidth: 1050,
    margin: "0 auto",
    textAlign: "center",
  },

  header: {
    marginBottom: 28,
  },

  logo: {
    fontSize: 15,
    fontWeight: 800,
    letterSpacing: 4,
    color: "#ffffff",
  },

  tagline: {
    marginTop: 8,
    fontSize: 11,
    letterSpacing: 3,
    color: "#7480a0",
  },

  title: {
    fontSize: "clamp(38px, 6vw, 68px)",
    lineHeight: 1.05,
    margin: "25px 0 20px",
    fontWeight: 800,
    letterSpacing: -2,
  },

  description: {
    color: "#9ba5c0",
    fontSize: 17,
    lineHeight: 1.7,
    marginBottom: 18,
  },

  status: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    color: "#8792ad",
    fontSize: 12,
    marginBottom: 32,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    display: "inline-block",
  },

  searchBox: {
    display: "flex",
    alignItems: "center",
    background: "rgba(20, 25, 43, 0.9)",
    border: "1px solid #293149",
    borderRadius: 28,
    padding: 10,
    margin: "0 auto 28px",
    maxWidth: 1000,
    boxShadow:
      "0 20px 60px rgba(0,0,0,0.25)",
  },

  searchIcon: {
    fontSize: 32,
    color: "#8490aa",
    marginLeft: 18,
    transform: "rotate(-20deg)",
  },

  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "#ffffff",
    fontSize: 18,
    padding: "18px 15px",
    minWidth: 0,
  },

  clearButton: {
    background: "transparent",
    border: "none",
    color: "#7d88a4",
    fontSize: 24,
    cursor: "pointer",
    padding: "0 10px",
  },

  searchButton: {
    border: "none",
    borderRadius: 22,
    padding: "17px 29px",
    fontSize: 16,
    fontWeight: 700,
    color: "#ffffff",
    background:
      "linear-gradient(135deg, #785cff, #29b9ee)",
    cursor: "pointer",
  },

  addButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "16px 28px",
    borderRadius: 18,
    border: "1px solid #2b3349",
    background: "rgba(18, 23, 39, 0.8)",
    color: "#ffffff",
    fontSize: 17,
    cursor: "pointer",
    marginBottom: 45,
  },

  cards: {
    display: "grid",
    gridTemplateColumns:
      "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 18,
    marginTop: 10,
  },

  card: {
    background: "rgba(13, 18, 32, 0.75)",
    border: "1px solid #20283c",
    borderRadius: 22,
    padding: 28,
    textAlign: "left",
  },

  cardIcon: {
    fontSize: 30,
    marginBottom: 15,
  },

  empty: {
    marginTop: 35,
    padding: 45,
    borderRadius: 25,
    background:
      "rgba(13, 18, 32, 0.7)",
    border: "1px solid #20283c",
  },

  emptyIcon: {
    fontSize: 40,
  },

  showAllButton: {
    marginTop: 15,
    padding: "12px 20px",
    borderRadius: 12,
    border: "1px solid #303a55",
    background: "#11182b",
    color: "#ffffff",
    cursor: "pointer",
  },

  loading: {
    color: "#7f8ba7",
    marginBottom: 30,
  },

  memoryList: {
    display: "grid",
    gap: 16,
    marginTop: 10,
    textAlign: "left",
  },

  resultTitle: {
    color: "#8e9ab7",
    fontSize: 13,
    marginBottom: 4,
    letterSpacing: 1,
    textTransform: "uppercase",
  },

  memoryCard: {
    background:
      "rgba(13, 18, 32, 0.85)",
    border: "1px solid #252e45",
    borderRadius: 20,
    padding: 22,
  },

  memoryTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 15,
    marginBottom: 12,
  },

  memoryLabel: {
    fontSize: 10,
    letterSpacing: 2,
    color: "#6f7b99",
    fontWeight: 800,
  },

  memoryDate: {
    fontSize: 11,
    color: "#66718d",
  },

  similarity: {
    fontSize: 11,
    color: "#55dca0",
  },

  memoryText: {
    fontSize: 17,
    lineHeight: 1.6,
    color: "#e8ebf5",
    whiteSpace: "pre-wrap",
  },

  deleteButton: {
    border: "1px solid #3b2730",
    background: "transparent",
    color: "#d98798",
    padding: "8px 13px",
    borderRadius: 9,
    cursor: "pointer",
  },

  // ----------------------------------------
  // AI ANSWER CARD
  // ----------------------------------------
  aiAnswerCard: {
    marginBottom: 22,
    padding: 28,
    borderRadius: 22,
    background:
      "linear-gradient(135deg, rgba(35, 28, 75, 0.85), rgba(12, 34, 52, 0.85))",
    border: "1px solid #3b3a78",
    textAlign: "left",
    boxShadow:
      "0 20px 60px rgba(0,0,0,0.25)",
  },

  aiAnswerLabel: {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 2,
    color: "#a99cff",
    marginBottom: 14,
  },

  aiAnswerText: {
    fontSize: 20,
    lineHeight: 1.6,
    color: "#f1f3fa",
  },

  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.72)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 100,
  },

  modal: {
    width: "100%",
    maxWidth: 620,
    background: "#0d1220",
    border: "1px solid #2a344d",
    borderRadius: 25,
    padding: 32,
    position: "relative",
    boxSizing: "border-box",
    boxShadow:
      "0 30px 100px rgba(0,0,0,0.55)",
  },

  closeButton: {
    position: "absolute",
    right: 20,
    top: 16,
    background: "transparent",
    border: "none",
    color: "#78839d",
    fontSize: 30,
    cursor: "pointer",
  },

  modalIcon: {
    fontSize: 38,
    marginBottom: 10,
  },

  modalTitle: {
    margin: 0,
    fontSize: 28,
  },

  modalDescription: {
    color: "#818ca5",
    lineHeight: 1.5,
  },

  textarea: {
    width: "100%",
    minHeight: 180,
    resize: "vertical",
    boxSizing: "border-box",
    background: "#080c16",
    border: "1px solid #2a344d",
    borderRadius: 15,
    padding: 16,
    color: "#ffffff",
    outline: "none",
    fontSize: 16,
    lineHeight: 1.5,
    fontFamily: "inherit",
    margin: "10px 0 18px",
  },

  saveButton: {
    width: "100%",
    padding: 16,
    border: "none",
    borderRadius: 14,
    background:
      "linear-gradient(135deg, #785cff, #29b9ee)",
    color: "#ffffff",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
  },
};

export default App;