"use client"

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'

interface ImageGenerationData {
  prompt: string
  imageName: string
  generatedImage: string | null
  isGenerating: boolean
  progress: number
  promptError: string
}

const IMAGE_GENERATION_KEY = 'imageGeneration'

const initialData: ImageGenerationData = {
  prompt: '',
  imageName: '',
  generatedImage: null,
  isGenerating: false,
  progress: 0,
  promptError: ''
}

export function useImageGeneration() {
  const queryClient = useQueryClient()
  const [imageData, setImageData] = useState<ImageGenerationData>(initialData)
  const imageDataRef = useRef<ImageGenerationData>(initialData)

  // Load data from query cache on mount
  useEffect(() => {
    const cachedData = queryClient.getQueryData<ImageGenerationData>([IMAGE_GENERATION_KEY])
    if (cachedData) {
      setImageData(cachedData)
      imageDataRef.current = cachedData
    }
  }, [queryClient])

  // Update image generation state
  const updateImageState = (updates: Partial<ImageGenerationData>) => {
    const newData = { ...imageDataRef.current, ...updates }
    setImageData(newData)
    imageDataRef.current = newData
    queryClient.setQueryData([IMAGE_GENERATION_KEY], newData)
  }

  // Generate image mutation
  const generateImageMutation = useMutation({
    mutationFn: async ({ prompt, imageName }: { prompt: string; imageName: string }) => {
      if (!prompt.trim()) throw new Error('Prompt is required')
      if (prompt.trim().length < 5) throw new Error('Prompt must be at least 5 characters long')

      updateImageState({
        promptError: '',
        isGenerating: true,
        progress: 0
      })

      // Simulate progress updates
      const progressInterval = setInterval(() => {
        const currentProgress = imageDataRef.current.progress
        updateImageState({
          progress: currentProgress >= 90 ? currentProgress : currentProgress + Math.random() * 10
        })
      }, 800)

      try {
        // Call our API route instead of OpenRouter directly
        const response = await fetch('/api/generate-image', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt }),
        })

        if (!response.ok) {
          const errorResult = await response.json()
          throw new Error(errorResult.error || `HTTP Error: ${response.status}`)
        }

        const result = await response.json()
        const generatedImageUrl = result.imageUrl

        clearInterval(progressInterval)
        updateImageState({ progress: 100 })

        // Check if image was generated
        if (generatedImageUrl) {
          return {
            generatedImage: generatedImageUrl,
            prompt,
            imageName
          }
        } else {
          throw new Error('Image generation completed but no image was received. Please try again.')
        }

      } catch (error) {
        clearInterval(progressInterval)
        throw error
      } finally {
        setTimeout(() => {
          updateImageState({
            isGenerating: false,
            progress: 0
          })
        }, 500)
      }
    },
    onSuccess: (data) => {
      updateImageState({
        generatedImage: data.generatedImage,
        prompt: data.prompt,
        imageName: data.imageName,
        promptError: ''
      })
    },
    onError: (error: Error) => {
      updateImageState({
        promptError: error.message,
        isGenerating: false,
        progress: 0
      })
    }
  })

  return {
    imageData: imageData!,
    updateImageState,
    generateImage: generateImageMutation.mutate,
    isGenerating: generateImageMutation.isPending
  }
}
