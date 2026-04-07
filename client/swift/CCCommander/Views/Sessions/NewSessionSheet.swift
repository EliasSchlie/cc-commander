import SwiftUI
import CCModels
import CCApp

struct NewSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var selectedMachineId: String?
    @State private var directory = ""
    @State private var prompt = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var selectedMachine: MachineInfo? {
        guard let id = selectedMachineId else { return nil }
        return appState.machines.first { $0.machineId == id }
    }

    var canSubmit: Bool {
        selectedMachineId != nil && !directory.isEmpty && !prompt.isEmpty && !isSubmitting
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Machine") {
                    if appState.onlineMachines.isEmpty {
                        Text("No machines online")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(appState.onlineMachines) { machine in
                        Button {
                            selectedMachineId = machine.machineId
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(machine.name)
                                    Text("Online")
                                        .font(.caption)
                                        .foregroundStyle(.green)
                                }
                                Spacer()
                                if selectedMachineId == machine.machineId {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                        .tint(.primary)
                    }

                    if !appState.offlineMachines.isEmpty {
                        DisclosureGroup("Offline") {
                            ForEach(appState.offlineMachines) { machine in
                                HStack {
                                    Text(machine.name)
                                    Spacer()
                                    Text("Offline")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section("Directory") {
                    TextField("/path/to/project", text: $directory)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                        #endif
                }

                Section("Prompt") {
                    TextField("What should Claude do?", text: $prompt, axis: .vertical)
                        .lineLimit(3...8)
                }

                if let error = errorMessage {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New Session")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .keyboardShortcut(.escape)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { submit() }
                        .disabled(!canSubmit)
                        .keyboardShortcut(.return)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, minHeight: 400)
        #endif
    }

    private func submit() {
        guard let machineId = selectedMachineId else { return }
        isSubmitting = true
        errorMessage = nil
        Task {
            do {
                try await appState.startSession(machineId: machineId, directory: directory, prompt: prompt)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }
}
